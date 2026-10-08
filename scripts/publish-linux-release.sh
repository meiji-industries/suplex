#!/usr/bin/env bash
# Uploads dist/linux/<arch> (from scripts/build-linux.sh) to R2 beside the Mac releases (SUPLEX_LINUX_ARCH=arm64 or x64).
set -euo pipefail

: "${CF_R2_ACCOUNT_ID:?Set CF_R2_ACCOUNT_ID}"
: "${CF_R2_ACCESS_KEY_ID:?Set CF_R2_ACCESS_KEY_ID}"
: "${CF_R2_SECRET_ACCESS_KEY:?Set CF_R2_SECRET_ACCESS_KEY}"
: "${CF_R2_BUCKET:?Set CF_R2_BUCKET}"
: "${SUPLEX_DESKTOP_UPDATE_URL:?Set SUPLEX_DESKTOP_UPDATE_URL}"

# SUPLEX_PUBLISH_PHASE: files uploads the release files, manifest points the download feed at them, all (default) does both.
phase="${SUPLEX_PUBLISH_PHASE:-all}"
case "$phase" in
  files|manifest|all) ;;
  *) echo "SUPLEX_PUBLISH_PHASE must be files, manifest, or all, not $phase" >&2; exit 1 ;;
esac
arch="${SUPLEX_LINUX_ARCH:-arm64}"
release_dir="dist/linux/$arch"
prefix="stable/linux/$arch"
endpoint="https://${CF_R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
# release.env holds the Apple silicon feed (.../stable/mac/arm64/); Linux publishes to stable/linux/<arch> beside it.
base_url="$(printf %s "${SUPLEX_DESKTOP_UPDATE_URL%/}" | sed -E "s#/mac/arm64\$#/linux/$arch#")"
case "$base_url" in
  https://*/"$prefix") ;;
  *) echo "SUPLEX_DESKTOP_UPDATE_URL must end in /stable/mac/arm64/" >&2; exit 1 ;;
esac

version="$(node -p "require('./package.json').version")"
tarball="$release_dir/suplex-$version-linux-$arch.tar.gz"
manifest="$release_dir/latest-linux.yml"
for artifact in "$tarball" "$tarball.sha256" "$manifest"; do
  [[ -e "$artifact" ]] || { echo "Missing $artifact; run mise run server:dist:linux" >&2; exit 1; }
done
(cd "$release_dir" && shasum -a 256 -c "$(basename "$tarball").sha256")
grep -qx "version: $version" "$manifest" || { echo "$manifest is not for $version" >&2; exit 1; }

export AWS_ACCESS_KEY_ID="$CF_R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$CF_R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto
export AWS_EC2_METADATA_DISABLED=true

upload_immutable() {
  local artifact="$1" content_type="$2" name
  name="$(basename "$artifact")"
  aws s3api put-object --endpoint-url "$endpoint" --bucket "$CF_R2_BUCKET" --key "$prefix/$name" --body "$artifact" --content-type "$content_type" --cache-control 'public, max-age=31536000, immutable' --if-none-match '*' >/dev/null
  curl --fail --silent --show-error --head "$base_url/$name" >/dev/null
}

if [[ "$phase" != manifest ]]; then
  upload_immutable "$tarball" application/gzip
  upload_immutable "$tarball.sha256" text/plain
fi
# The manifest goes last, so the download link never points at a file that is not uploaded yet.
if [[ "$phase" != files ]]; then
  curl --fail --silent --show-error --head "$base_url/$(basename "$tarball")" >/dev/null
  aws s3api put-object --endpoint-url "$endpoint" --bucket "$CF_R2_BUCKET" --key "$prefix/latest-linux.yml" --body "$manifest" --content-type text/yaml --cache-control no-cache >/dev/null
  curl --fail --silent --show-error "$base_url/latest-linux.yml" | cmp - "$manifest"
  echo "Published $base_url/$(basename "$tarball")"
fi
