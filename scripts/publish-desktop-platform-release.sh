#!/usr/bin/env bash
# Uploads desktop/release/<platform>-<arch> (scripts/build-desktop-linux.sh or build-desktop-windows.sh) to R2
# beside the Mac releases: SUPLEX_DESKTOP_PLATFORM=linux|windows and SUPLEX_DESKTOP_ARCH=arm64|x64.
# SUPLEX_PUBLISH_PHASE: files uploads the release files, manifest points both feeds at them, all (default) does both.
# SUPLEX_PUBLISH_DRY_RUN=1 performs every local check and prints the uploads without credentials or network writes.
set -euo pipefail

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

platform="${SUPLEX_DESKTOP_PLATFORM:?Set SUPLEX_DESKTOP_PLATFORM to linux or windows}"
arch="${SUPLEX_DESKTOP_ARCH:?Set SUPLEX_DESKTOP_ARCH to arm64 or x64}"
version="$(node -p "require('./desktop/package.json').version")"
release_dir="desktop/release/$platform-$arch"
prefix="stable/$platform/$arch"
# release.env holds the Apple silicon feed (.../stable/mac/arm64/); each platform publishes to its own folder beside it.
base_url="$(printf %s "${SUPLEX_DESKTOP_UPDATE_URL%/}" | sed -E "s#/mac/arm64\$#/$platform/$arch#")"
case "$base_url" in
  https://*/"$prefix") ;;
  *) echo "SUPLEX_DESKTOP_UPDATE_URL must end in /stable/mac/arm64/" >&2; exit 1 ;;
esac
case "$platform" in
  linux) binaries=("Suplex-$version-linux-$arch.deb" "Suplex-$version-linux-$arch.rpm"); manifest=latest-linux-desktop.yml ;;
  windows) binaries=("Suplex-$version-windows-$arch-setup.exe"); manifest=latest-windows.yml ;;
  *) echo "SUPLEX_DESKTOP_PLATFORM must be linux or windows" >&2; exit 1 ;;
esac
for name in "${binaries[@]}" "${binaries[@]/%/.sig}" latest-tauri.json "$manifest"; do
  [[ -f "$release_dir/$name" ]] || { echo "Missing $release_dir/$name; build it with mise run desktop:dist:$platform and an updater key" >&2; exit 1; }
done
# Both manifests describe this version and name files that exist here, with matching signatures.
grep -qx "version: $version" "$release_dir/$manifest" || { echo "$release_dir/$manifest is not for $version" >&2; exit 1; }
node -e '
const fs = require("fs");
const [dir, version, base, ...names] = process.argv.slice(1);
const value = JSON.parse(fs.readFileSync(`${dir}/latest-tauri.json`, "utf8"));
const entries = Object.values(value.platforms ?? {});
const ok = value.version === version && entries.length === names.length && names.every((name) =>
  entries.some((entry) => entry.url === `${base}/${name}` && entry.signature === fs.readFileSync(`${dir}/${name}.sig`, "utf8").trim()));
if (!ok) process.exit(1);
' "$release_dir" "$version" "$base_url" "${binaries[@]}" || { echo "$release_dir/latest-tauri.json does not describe these files" >&2; exit 1; }
(cd "$release_dir" && shasum -a 256 "${binaries[@]}")

export AWS_ACCESS_KEY_ID="${CF_R2_ACCESS_KEY_ID:-}"
export AWS_SECRET_ACCESS_KEY="${CF_R2_SECRET_ACCESS_KEY:-}"
export AWS_DEFAULT_REGION=auto
export AWS_EC2_METADATA_DISABLED=true
endpoint="https://${CF_R2_ACCOUNT_ID:-dry-run}.r2.cloudflarestorage.com"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

# Release files are immutable. A retry after a partial publication accepts an object that is already live
# only when its public bytes are identical to this file; it never overwrites a different object.
upload_immutable() {
  local artifact="$1" content_type="$2" name key
  name="$(basename "$artifact")"
  key="$prefix/$name"
  if [[ -n "$dry_run" ]]; then echo "dry run: would upload $key ($content_type, immutable)"; return; fi
  if ! aws s3api put-object --endpoint-url "$endpoint" --bucket "$CF_R2_BUCKET" --key "$key" --body "$artifact" --content-type "$content_type" --cache-control 'public, max-age=31536000, immutable' --if-none-match '*' >/dev/null 2>"$scratch/upload.err"; then
    grep -q PreconditionFailed "$scratch/upload.err" || { cat "$scratch/upload.err" >&2; return 1; }
    curl --fail --silent --show-error --output "$scratch/live" "$base_url/$name"
    cmp -s "$artifact" "$scratch/live" || { echo "$base_url/$name already exists with different contents; choose a new release version." >&2; return 1; }
    echo "$key is already published with identical contents"
  fi
  curl --fail --silent --show-error --head "$base_url/$name" >/dev/null
}

publish_manifest() {
  local file="$1" content_type="$2" name
  name="$(basename "$file")"
  if [[ -n "$dry_run" ]]; then echo "dry run: would publish $prefix/$name ($content_type, no-cache)"; return; fi
  aws s3api put-object --endpoint-url "$endpoint" --bucket "$CF_R2_BUCKET" --key "$prefix/$name" --body "$file" --content-type "$content_type" --cache-control no-cache >/dev/null
  curl --fail --silent --show-error "$base_url/$name" | cmp - "$file"
}

content_type() {
  case "$1" in
    *.deb) echo application/vnd.debian.binary-package ;;
    *.rpm) echo application/x-rpm ;;
    *.exe) echo application/vnd.microsoft.portable-executable ;;
    *) echo text/plain ;;
  esac
}

if [[ "$phase" != manifest ]]; then
  for name in "${binaries[@]}"; do
    upload_immutable "$release_dir/$name" "$(content_type "$name")"
    upload_immutable "$release_dir/$name.sig" text/plain
  done
fi
# The manifests go last, so neither feed points at a file that is not uploaded yet.
if [[ "$phase" != files ]]; then
  if [[ -z "$dry_run" ]]; then
    for name in "${binaries[@]}"; do
      curl --fail --silent --show-error --output "$scratch/live" "$base_url/$name" || { echo "$base_url/$name is not published; run the files phase first." >&2; exit 1; }
      cmp -s "$release_dir/$name" "$scratch/live" || { echo "$base_url/$name differs from the local build; choose a new release version." >&2; exit 1; }
    done
  fi
  publish_manifest "$release_dir/latest-tauri.json" application/json
  publish_manifest "$release_dir/$manifest" text/yaml
  [[ -n "$dry_run" ]] || echo "Published $platform $arch $version at $base_url/"
fi
