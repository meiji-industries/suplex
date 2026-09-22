#!/usr/bin/env bash
set -euo pipefail

: "${CF_R2_ACCOUNT_ID:?Set CF_R2_ACCOUNT_ID}"
: "${CF_R2_ACCESS_KEY_ID:?Set CF_R2_ACCESS_KEY_ID}"
: "${CF_R2_SECRET_ACCESS_KEY:?Set CF_R2_SECRET_ACCESS_KEY}"
: "${CF_R2_BUCKET:?Set CF_R2_BUCKET}"
: "${SUPLEX_DESKTOP_UPDATE_URL:?Set SUPLEX_DESKTOP_UPDATE_URL}"

release_dir=desktop/release
prefix=stable/mac/arm64
endpoint="https://${CF_R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
base_url="${SUPLEX_DESKTOP_UPDATE_URL%/}"

case "$base_url" in
  https://*/"$prefix") ;;
  *) echo "SUPLEX_DESKTOP_UPDATE_URL must end in /$prefix/" >&2; exit 1 ;;
esac

zips=("$release_dir"/Suplex-*-arm64-mac.zip)
dmgs=("$release_dir"/Suplex-*-arm64.dmg)
(( ${#zips[@]} == 1 )) || { echo "Expected one arm64 ZIP in $release_dir" >&2; exit 1; }
(( ${#dmgs[@]} == 1 )) || { echo "Expected one arm64 DMG in $release_dir" >&2; exit 1; }
zip="${zips[0]}"
dmg="${dmgs[0]}"
blockmap="$zip.blockmap"
manifest="$release_dir/latest-mac.yml"
app="$release_dir/mac-arm64/Suplex.app"
for artifact in "$app" "$zip" "$blockmap" "$dmg" "$manifest"; do
  [[ -e "$artifact" ]] || { echo "Missing $artifact" >&2; exit 1; }
done

codesign --verify --deep --strict "$app"
spctl --assess --type execute -vv "$app"
xcrun stapler validate "$dmg"
zip_check="$(mktemp -d)"
trap 'rm -rf "$zip_check"' EXIT
ditto -x -k "$zip" "$zip_check"
codesign --verify --deep --strict "$zip_check/Suplex.app"
shasum -a 256 "$zip" "$blockmap" "$dmg"

export AWS_ACCESS_KEY_ID="$CF_R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$CF_R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto
export AWS_EC2_METADATA_DISABLED=true

upload_immutable() {
  local artifact="$1" content_type="$2" name key
  name="$(basename "$artifact")"
  key="$prefix/$name"
  aws s3api put-object --endpoint-url "$endpoint" --bucket "$CF_R2_BUCKET" --key "$key" --body "$artifact" --content-type "$content_type" --cache-control 'public, max-age=31536000, immutable' --if-none-match '*' >/dev/null
  curl --fail --silent --show-error --head "$base_url/$name" >/dev/null
  curl --fail --silent --show-error --range 0-0 --output /dev/null "$base_url/$name"
}

upload_immutable "$zip" application/zip
upload_immutable "$blockmap" application/octet-stream
upload_immutable "$dmg" application/x-apple-diskimage

aws s3api put-object --endpoint-url "$endpoint" --bucket "$CF_R2_BUCKET" --key "$prefix/latest-mac.yml" --body "$manifest" --content-type text/yaml --cache-control no-cache >/dev/null
curl --fail --silent --show-error --head "$base_url/latest-mac.yml" >/dev/null
curl --fail --silent --show-error --range 0-0 --output /dev/null "$base_url/latest-mac.yml"
