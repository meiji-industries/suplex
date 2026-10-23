# Installs or updates the suplex binary, as root. suplex.sh/install.sh refuses root (it also starts a host), so this
# mirrors the installer's Linux branch exactly: download the release, verify its checksum, install the binary.
# The binary belongs to the service user at /home/suplex/.local/bin/suplex, so the in-app update can replace it;
# /usr/local/bin/suplex is a symlink to it for the admin shell.
set -e
case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
FILE=$(curl -fsSL -w '%{url_effective}' -o "$T/suplex.tar.gz" "https://suplex.sh/download?platform=linux-$ARCH&format=tar.gz")
curl -fsSL -o "$T/suplex.sha256" "$FILE.sha256"
[ "$(cut -d' ' -f1 "$T/suplex.sha256")" = "$(sha256sum "$T/suplex.tar.gz" | cut -d' ' -f1)" ] || { echo "suplex download does not match its checksum; nothing installed"; exit 1; }
tar -xzf "$T/suplex.tar.gz" -C "$T" suplex
runuser -u suplex -- mkdir -p /home/suplex/.local/bin
install -m 0755 -o suplex -g suplex "$T/suplex" /home/suplex/.local/bin/suplex
ln -sfn /home/suplex/.local/bin/suplex /usr/local/bin/suplex
/usr/local/bin/suplex version
