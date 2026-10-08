#!/usr/bin/env bash
set -euo pipefail

# SUPLEX_PUBLISH_PHASE: files uploads the release files, manifest points both update feeds at them, all (default) does both.
# SUPLEX_PUBLISH_DRY_RUN=1 performs every local check and prints the uploads without credentials or network writes.
phase="${SUPLEX_PUBLISH_PHASE:-all}"
case "$phase" in
  files|manifest|all) ;;
  *) echo "SUPLEX_PUBLISH_PHASE must be files, manifest, or all, not $phase" >&2; exit 1 ;;
esac
dry_run="${SUPLEX_PUBLISH_DRY_RUN:-}"
if [[ -z "$dry_run" ]]; then
  : "${CF_R2_ACCOUNT_ID:?Set CF_R2_ACCOUNT_ID}"
  : "${CF_R2_ACCESS_KEY_ID:?Set CF_R2_ACCESS_KEY_ID}"
  : "${CF_R2_SECRET_ACCESS_KEY:?Set CF_R2_SECRET_ACCESS_KEY}"
  : "${CF_R2_BUCKET:?Set CF_R2_BUCKET}"
fi
: "${SUPLEX_DESKTOP_UPDATE_URL:?Set SUPLEX_DESKTOP_UPDATE_URL}"

arch="${SUPLEX_DESKTOP_ARCH:-arm64}"
release_dir="apps/desktop/release/$arch"
prefix="stable/mac/$arch"
# release.env holds the Apple silicon feed; each architecture publishes to its own folder beside it.
base_url="$(printf %s "${SUPLEX_DESKTOP_UPDATE_URL%/}" | sed -E "s#/mac/arm64\$#/mac/$arch#")"

case "$base_url" in
  https://*/"$prefix") ;;
  *) echo "SUPLEX_DESKTOP_UPDATE_URL must end in /$prefix/" >&2; exit 1 ;;
esac

version="$(node -p "require('./apps/desktop/package.json').version")"
app="$release_dir/Suplex.app"
zip="$release_dir/Suplex-$version-$arch-mac.zip"
dmg="$release_dir/Suplex-$version-$arch.dmg"
tarball="$release_dir/Suplex-$version-$arch.app.tar.gz"
mac_manifest="$release_dir/latest-mac.yml"
tauri_manifest="$release_dir/latest-tauri.json"
for artifact in "$app" "$zip" "$dmg" "$tarball" "$tarball.sig" "$mac_manifest" "$tauri_manifest"; do
  [[ -e "$artifact" ]] || { echo "Missing $artifact" >&2; exit 1; }
done

codesign --verify --deep --strict "$app"
# The app checks this feed for its next update; a release that points elsewhere, or nowhere, strands its installs.
grep -qx "url: $base_url/" "$app/Contents/Resources/app-update.yml" || { echo "$app does not update from $base_url/" >&2; exit 1; }
# Both manifests describe this version and name files that exist here, with matching hashes and signature.
grep -qx "version: $version" "$mac_manifest" && grep -qx "path: $(basename "$zip")" "$mac_manifest" \
  && grep -qx "sha512: $(openssl dgst -sha512 -binary "$zip" | base64)" "$mac_manifest" \
  || { echo "$mac_manifest does not describe $zip" >&2; exit 1; }
node -e '
const [manifest, version, url, signature] = process.argv.slice(1);
const value = JSON.parse(require("fs").readFileSync(manifest, "utf8"));
const entries = Object.values(value.platforms ?? {});
if (value.version !== version || entries.length !== 1 || entries[0].url !== url || entries[0].signature !== require("fs").readFileSync(signature, "utf8").trim()) process.exit(1);
' "$tauri_manifest" "$version" "$base_url/$(basename "$tarball")" "$tarball.sig" || { echo "$tauri_manifest does not describe $tarball" >&2; exit 1; }
if [[ -z "$dry_run" ]]; then
  spctl --assess --type execute -vv "$app"
  xcrun stapler validate "$dmg"
fi
zip_check="$(mktemp -d)"
trap 'rm -rf "$zip_check"' EXIT
ditto -x -k "$zip" "$zip_check"
codesign --verify --deep --strict "$zip_check/Suplex.app"
shasum -a 256 "$zip" "$dmg" "$tarball"

export AWS_ACCESS_KEY_ID="${CF_R2_ACCESS_KEY_ID:-}"
export AWS_SECRET_ACCESS_KEY="${CF_R2_SECRET_ACCESS_KEY:-}"
export AWS_DEFAULT_REGION=auto
export AWS_EC2_METADATA_DISABLED=true
endpoint="https://${CF_R2_ACCOUNT_ID:-dry-run}.r2.cloudflarestorage.com"

# Release files are immutable. A retry after a partial publication accepts an object that is already live
# only when its public bytes are identical to this file; it never overwrites a different object.
upload_immutable() {
  local artifact="$1" content_type="$2" name key
  name="$(basename "$artifact")"
  key="$prefix/$name"
  if [[ -n "$dry_run" ]]; then echo "dry run: would upload $key ($content_type, immutable)"; return; fi
  if ! aws s3api put-object --endpoint-url "$endpoint" --bucket "$CF_R2_BUCKET" --key "$key" --body "$artifact" --content-type "$content_type" --cache-control 'public, max-age=31536000, immutable' --if-none-match '*' >/dev/null 2>"$zip_check/upload.err"; then
    grep -q PreconditionFailed "$zip_check/upload.err" || { cat "$zip_check/upload.err" >&2; return 1; }
    curl --fail --silent --show-error --output "$zip_check/live" "$base_url/$name"
    cmp -s "$artifact" "$zip_check/live" || { echo "$base_url/$name already exists with different contents; choose a new release version." >&2; return 1; }
    echo "$key is already published with identical contents"
  fi
  curl --fail --silent --show-error --head "$base_url/$name" >/dev/null
  curl --fail --silent --show-error --range 0-0 --output /dev/null "$base_url/$name"
}

publish_manifest() {
  local manifest="$1" content_type="$2" name
  name="$(basename "$manifest")"
  if [[ -n "$dry_run" ]]; then echo "dry run: would publish $prefix/$name ($content_type, no-cache)"; return; fi
  aws s3api put-object --endpoint-url "$endpoint" --bucket "$CF_R2_BUCKET" --key "$prefix/$name" --body "$manifest" --content-type "$content_type" --cache-control no-cache >/dev/null
  curl --fail --silent --show-error --head "$base_url/$name" >/dev/null
  curl --fail --silent --show-error --range 0-0 --output /dev/null "$base_url/$name"
}

if [[ "$phase" != manifest ]]; then
  upload_immutable "$zip" application/zip
  upload_immutable "$dmg" application/x-apple-diskimage
  upload_immutable "$tarball" application/gzip
fi

if [[ "$phase" != files ]]; then
  # Point the feeds only at published files whose bytes are this build's: the manifests carry its hash and signature.
  if [[ -z "$dry_run" ]]; then
    for artifact in "$zip" "$dmg" "$tarball"; do
      name="$(basename "$artifact")"
      curl --fail --silent --show-error --output "$zip_check/live" "$base_url/$name" || { echo "$base_url/$name is not published; run the files phase first." >&2; exit 1; }
      cmp -s "$artifact" "$zip_check/live" || { echo "$base_url/$name differs from the local build; choose a new release version." >&2; exit 1; }
    done
  fi
  publish_manifest "$mac_manifest" text/yaml
  publish_manifest "$tauri_manifest" application/json
fi
