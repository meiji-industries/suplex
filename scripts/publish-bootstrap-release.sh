#!/usr/bin/env bash
# Uploads dist/bootstrap/<platform> (from scripts/build-bootstrap.sh) to R2 at stable/bootstrap/<platform>, where
# suplex.sh/download?platform=bootstrap-<platform> and suplex.sh/bootstrap.sh find it.
set -euo pipefail

: "${CF_R2_ACCOUNT_ID:?Set CF_R2_ACCOUNT_ID}"
: "${CF_R2_ACCESS_KEY_ID:?Set CF_R2_ACCESS_KEY_ID}"
: "${CF_R2_SECRET_ACCESS_KEY:?Set CF_R2_SECRET_ACCESS_KEY}"
: "${CF_R2_BUCKET:?Set CF_R2_BUCKET}"
: "${SUPLEX_DESKTOP_UPDATE_URL:?Set SUPLEX_DESKTOP_UPDATE_URL}"

platforms="macos-arm64 macos-x64 linux-arm64 linux-x64"
endpoint="https://${CF_R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
# release.env holds the Apple silicon feed (.../stable/mac/arm64/); the bootstrap feeds sit beside it.
root="$(printf %s "${SUPLEX_DESKTOP_UPDATE_URL%/}" | sed -E 's#/mac/arm64$#/bootstrap#')"
case "$root" in
  https://*/stable/bootstrap) ;;
  *) echo "SUPLEX_DESKTOP_UPDATE_URL must end in /stable/mac/arm64/" >&2; exit 1 ;;
esac

export AWS_ACCESS_KEY_ID="$CF_R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$CF_R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto
export AWS_EC2_METADATA_DISABLED=true

put() { # platform, file, content type, cache control, extra args
  aws s3api put-object --endpoint-url "$endpoint" --bucket "$CF_R2_BUCKET" --key "stable/bootstrap/$1/$(basename "$2")" \
    --body "$2" --content-type "$3" --cache-control "$4" "${@:5}" >/dev/null
}

for platform in $platforms; do
  dir="dist/bootstrap/$platform"
  tarball="$(cd "$dir" && ls suplex-bootstrap-*.tar.gz)"
  (cd "$dir" && shasum -a 256 -c "$tarball.sha256")
  for file in "$tarball" "$tarball.sha256"; do
    type="$([ "$file" = "$tarball" ] && echo application/gzip || echo text/plain)"
    # Release files are immutable. A rerun skips a file already uploaded with the same contents.
    if ! put "$platform" "$dir/$file" "$type" 'public, max-age=31536000, immutable' --if-none-match '*' 2>/dev/null; then
      curl --fail --silent --show-error "$root/$platform/$file" | cmp -s - "$dir/$file" \
        || { echo "$root/$platform/$file exists with other contents. Bump the version in apps/bootstrap/Cargo.toml." >&2; exit 1; }
    fi
  done
done
# The manifests go last, so a download link never points at a file that is not uploaded yet.
for platform in $platforms; do
  put "$platform" "dist/bootstrap/$platform/latest.yml" text/yaml no-cache
  curl --fail --silent --show-error "$root/$platform/latest.yml" | cmp - "dist/bootstrap/$platform/latest.yml"
  echo "Published $root/$platform/$(sed -n 's/^  - url: //p' "dist/bootstrap/$platform/latest.yml")"
done
