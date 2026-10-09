#!/bin/sh
# Installs suplex-bootstrap in ~/.local/bin, then starts it. It runs Suplex on a cloud server: it creates or
# connects to the server, installs and configures Suplex there, and prints a login link.
#   curl -fsSL https://suplex.sh/bootstrap.sh | sh
# Run it again to update. Set SUPLEX_NO_START=1 to install only, SUPLEX_BIN_DIR to install somewhere else.

# Everything runs from main, so a partial download cannot run half a script.
main() {
set -eu

case "$(uname -s)" in
    Darwin) OS=macos ;;
    Linux) OS=linux ;;
    *) error "suplex-bootstrap runs on macOS and Linux only." ;;
esac
case "$(uname -m)" in
    arm64|aarch64) ARCH=arm64 ;;
    x86_64|amd64) ARCH=x64 ;;
    *) error "Unsupported architecture: $(uname -m)" ;;
esac
# A shell under Rosetta reports x86_64 on Apple silicon.
[ "$OS" = macos ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ] && ARCH=arm64

for tool in curl tar ssh scp; do
    command -v "$tool" >/dev/null 2>&1 || error "suplex-bootstrap needs $tool. Install it, then run this script again."
done

BIN_DIR="${SUPLEX_BIN_DIR:-$HOME/.local/bin}"
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

status "Downloading suplex-bootstrap for $OS ($ARCH)..."
FILE=$(curl --fail --show-error --location --progress-bar -w '%{url_effective}' \
    -o "$TEMP_DIR/suplex-bootstrap.tar.gz" "https://suplex.sh/download?platform=bootstrap-$OS-$ARCH")
curl --fail --silent --show-error --location -o "$TEMP_DIR/suplex-bootstrap.sha256" "$FILE.sha256"
[ "$(cut -d' ' -f1 "$TEMP_DIR/suplex-bootstrap.sha256")" = "$(sha256 "$TEMP_DIR/suplex-bootstrap.tar.gz")" ] \
    || error "The download does not match its checksum. Nothing was installed."
tar -xzf "$TEMP_DIR/suplex-bootstrap.tar.gz" -C "$TEMP_DIR" suplex-bootstrap
if [ "$OS" = macos ]; then
    codesign --verify --strict -R='anchor apple generic and certificate leaf[subject.OU] = "6KY6743H52"' "$TEMP_DIR/suplex-bootstrap" \
        || error "The download is not signed by Meiji Industries. Nothing was installed."
fi

mkdir -p "$BIN_DIR"
# A move replaces the file, so a running suplex-bootstrap keeps its old copy.
mv -f "$TEMP_DIR/suplex-bootstrap" "$BIN_DIR/suplex-bootstrap"
status "Installed $("$BIN_DIR/suplex-bootstrap" --version) in $BIN_DIR."
case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) status "$BIN_DIR is not on your PATH. Add it to your shell profile, or run $BIN_DIR/suplex-bootstrap." ;;
esac
status "Run 'suplex-bootstrap help' for the server commands (status, up, down, ssh, logs, recover)."

[ -n "${SUPLEX_NO_START:-}" ] && exit 0
# `curl | sh` feeds this script on stdin, so the wizard reads the terminal.
if (: </dev/tty) 2>/dev/null; then
    exec "$BIN_DIR/suplex-bootstrap" </dev/tty
fi
status "No terminal is available. Run suplex-bootstrap to set up a server."
}

status() { echo ">>> $*" >&2; }
error() { echo "ERROR: $*" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

main "$@"
