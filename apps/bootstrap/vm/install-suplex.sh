# Installs or updates the suplex binary in /usr/local/bin, as root. suplex.sh/install.sh refuses root (it also
# starts a host), and the service user has no sudo to write /usr/local/bin, so this mirrors the installer's Linux
# branch exactly: download the release, verify its checksum, install the binary.
set -e
case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
FILE=$(curl -fsSL -w '%{url_effective}' -o "$T/suplex.tar.gz" "https://suplex.sh/download?platform=linux-$ARCH&format=tar.gz")
curl -fsSL -o "$T/suplex.sha256" "$FILE.sha256"
[ "$(cut -d' ' -f1 "$T/suplex.sha256")" = "$(sha256sum "$T/suplex.tar.gz" | cut -d' ' -f1)" ] || { echo "suplex download does not match its checksum; nothing installed"; exit 1; }
tar -xzf "$T/suplex.tar.gz" -C "$T" suplex
install -m 0755 "$T/suplex" /usr/local/bin/suplex
/usr/local/bin/suplex version
