#!/bin/sh
# Installs Suplex.
#   macOS: Suplex.app in /Applications and the `suplex` command in /usr/local/bin.
#   Linux: the `suplex` command in /usr/local/bin, then runs the web server in this terminal.
#   curl -fsSL https://suplex.sh/install.sh | sh
# Set SUPLEX_NO_START=1 to skip starting Suplex after the install.

# Everything runs from main, so a partial download cannot run half a script.
main() {
set -eu

if [ "$(uname -s)" = Linux ] && [ "$(id -u)" = 0 ]; then
    error "Suplex cannot run as root. Start Suplex as a dedicated non-root user. See https://github.com/meiji-industries/suplex/blob/main/README.md#linux-host."
fi

cat >&2 <<'BANNER'
  _______ ___ ___ _______ ___     _______  ___ ___
 |   _   |   Y   |   _   |   |   |   _   |(   Y   )
 |   1___|.  |   |.  1   |.  |   |.  1___| \  1  /
 |____   |.  |   |.  ____|.  |___|.  __)_  /  _  \
 |:  1   |:  1   |:  |   |:  1   |:  1   |/:  |   \
 |::.. . |::.. . |::.|   |::.. . |::.. . (::. |:.  )
 `-------`-------`---'   `-------`-------'`--- ---'

BANNER

case "$(uname -m)" in
    arm64|aarch64) ARCH=arm64 ;;
    x86_64|amd64) ARCH=x64 ;;
    *) error "Unsupported architecture: $(uname -m)" ;;
esac

LINK="/usr/local/bin/suplex"
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

case "$(uname -s)" in
    Darwin) install_macos ;;
    Linux) install_linux ;;
    MINGW*|MSYS*|CYGWIN*) error "On Windows, run this in PowerShell instead: irm https://suplex.sh/install.ps1 | iex" ;;
    *) error "Suplex installs on macOS and Linux only." ;;
esac
}

status() { echo ">>> $*" >&2; }
error() { echo "ERROR: $*" >&2; exit 1; }
# Runs the command as this user, then with sudo if that is not permitted.
as_admin() { "$@" 2>/dev/null || sudo "$@"; }

install_macos() {
    [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 14 ] || error "Suplex requires macOS 14 Sonoma or later."
    # A shell under Rosetta reports x86_64 on Apple silicon.
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ] && ARCH=arm64

    APP="/Applications/Suplex.app"
    TEAM_ID="6KY6743H52"

    status "Downloading Suplex for macOS ($ARCH)..."
    curl --fail --show-error --location --progress-bar \
        -o "$TEMP_DIR/Suplex.zip" "https://suplex.sh/download?platform=macos-$ARCH&format=zip"
    ditto -x -k "$TEMP_DIR/Suplex.zip" "$TEMP_DIR"
    codesign --verify --deep --strict -R="anchor apple generic and certificate leaf[subject.OU] = \"$TEAM_ID\"" "$TEMP_DIR/Suplex.app" \
        || error "The download is not signed by Meiji Industries. Nothing was installed."

    if pgrep -x Suplex >/dev/null 2>&1; then
        status "Quitting Suplex..."
        # A normal quit lets the app stop the Suplex server it started. Wait only when macOS accepted the quit.
        if osascript -e 'tell application "Suplex" to quit' >/dev/null 2>&1; then
            for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x Suplex >/dev/null 2>&1 || break; sleep 1; done
        fi
        if pgrep -x Suplex >/dev/null 2>&1; then
            # macOS refuses the quit while a dialog is open. SIGTERM still quits the app normally, except under the
            # app-modal dialogs of 1.2.0 and earlier, which stop the whole process until they are answered.
            status "Suplex did not quit. Stopping it..."
            for SIGNAL in TERM KILL; do
                pkill -"$SIGNAL" -x Suplex || true
                for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x Suplex >/dev/null 2>&1 || break; sleep 1; done
            done
            pgrep -x Suplex >/dev/null 2>&1 && error "Suplex did not stop. Quit Suplex, then run this script again."
        fi
    fi
    # A server the app did not stop would keep the old version running, and the new app would use it.
    # `down` reads a .suplex in the current directory first, so run it where there is none.
    STOPPED=$( (cd "$TEMP_DIR" && "$APP/Contents/Resources/runtime/bin/suplex" down) 2>/dev/null || true)
    case "$STOPPED" in *'"stopped":1'*) status "The Suplex server stopped. Open Suplex or run 'suplex up' to start it again." ;; esac

    status "Installing Suplex to /Applications..."
    [ -d "$APP" ] && as_admin rm -rf "$APP"
    as_admin mv "$TEMP_DIR/Suplex.app" "$APP"

    TARGET="$APP/Contents/Resources/runtime/bin/suplex"
    if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
        status "$LINK is a separate suplex install. It was left unchanged."
    elif [ "$(readlink "$LINK" 2>/dev/null || true)" != "$TARGET" ]; then
        status "Adding the 'suplex' command to PATH (your password may be necessary)..."
        as_admin mkdir -p "$(dirname "$LINK")"
        as_admin ln -sf "$TARGET" "$LINK"
    fi

    status "Install complete. Run 'suplex help' for the command line."
    [ -n "${SUPLEX_NO_START:-}" ] && exit 0

    # `curl | sh` feeds this script on stdin, so ask on the terminal. Without one, open the desktop app.
    CHOICE=a
    if (: </dev/tty) 2>/dev/null; then
        cat >/dev/tty <<'MENU'

How do you want to run Suplex?
  a) Desktop app (RECOMMENDED)
  b) Run web server only
  c) Exit
MENU
        while :; do
            printf 'Choose [a]: ' >/dev/tty
            read -r CHOICE </dev/tty || CHOICE=a
            case "${CHOICE:-a}" in
                a|A) CHOICE=a; break ;;
                b|B) CHOICE=b; break ;;
                c|C) CHOICE=c; break ;;
            esac
        done
    fi

    case "$CHOICE" in
        a) status "Opening Suplex..."; open "$APP" ;;
        # The desktop app's data, so both show the same work.
        b) export SUPLEX_PACKAGED=1; serve_web "$HOME/Library/Application Support/Suplex" ;;
    esac
}

install_linux() {
    for tool in curl tar sha256sum; do
        command -v "$tool" >/dev/null 2>&1 || error "Suplex needs $tool. Install it with your package manager, then run this script again."
    done

    status "Downloading Suplex for Linux ($ARCH)..."
    FILE=$(curl --fail --show-error --location --progress-bar -w '%{url_effective}' \
        -o "$TEMP_DIR/suplex.tar.gz" "https://suplex.sh/download?platform=linux-$ARCH&format=tar.gz")
    curl --fail --silent --show-error --location -o "$TEMP_DIR/suplex.sha256" "$FILE.sha256"
    [ "$(cut -d' ' -f1 "$TEMP_DIR/suplex.sha256")" = "$(sha256sum "$TEMP_DIR/suplex.tar.gz" | cut -d' ' -f1)" ] \
        || error "The download does not match its checksum. Nothing was installed."
    tar -xzf "$TEMP_DIR/suplex.tar.gz" -C "$TEMP_DIR" suplex

    status "Installing the 'suplex' command to $LINK (your password may be necessary)..."
    as_admin mkdir -p "$(dirname "$LINK")"
    as_admin install -m 0755 "$TEMP_DIR/suplex" "$LINK"
    TARGET="$LINK"

    status "Install complete. Run 'suplex help' for the command line."
    [ -n "${SUPLEX_NO_START:-}" ] && exit 0
    serve_web "${XDG_DATA_HOME:-$HOME/.local/share}/Suplex"
}

# Opens the URL in a browser when this computer has one; a server without a display prints it instead.
open_url() {
    if [ "$(uname -s)" = Darwin ]; then
        open "$1"
    elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$1" >/dev/null 2>&1 || true
    else
        status "Suplex is ready. Open $1 in a browser on this computer, or from another computer run: ssh -L 4111:127.0.0.1:4111 $(hostname 2>/dev/null || echo this-server)"
    fi
}

# Runs the Suplex server in this terminal with its data in $1.
serve_web() {
    URL="http://127.0.0.1:4111"
    DATA="$1"
    # Herdr installs to ~/.local/bin, which the desktop app also puts on the server's PATH.
    export PATH="$HOME/.local/bin:$PATH"
    export SUPLEX_ACCESS_MODE=local SUPLEX_BIND_ADDRESS=127.0.0.1 SUPLEX_PORT=4111 \
        SUPLEX_DATA_ROOT="$DATA/data" SUPLEX_ENV_FILE="$DATA/suplex.env" \
        SUPLEX_REPOSITORY_ROOT="$HOME/suplex/repos" SUPLEX_WORKTREE_ROOT="$HOME/suplex/worktrees"

    if curl -fsS -o /dev/null "$URL/health" 2>/dev/null; then
        status "Suplex is already running at $URL"
        open_url "$URL"
        return
    fi

    # The same setup steps the desktop app runs before it first starts the server.
    mkdir -p "$DATA"
    while IFS='|' read -r STAGE TITLE; do
        status "$TITLE..."
        RESULT=$("$TARGET" install --stage "$STAGE" --json 2>"$TEMP_DIR/install.log" | tail -n 1) || true
        case "$RESULT" in
            *'"ok":true'*) ;;
            *) cat "$TEMP_DIR/install.log" >&2
               error "$TITLE failed: $(printf %s "$RESULT" | sed -n 's/.*"reason":"\([^"]*\)".*/\1/p')" ;;
        esac
    done <<STAGES
$("$TARGET" install --manifest | grep -o '{"name":"[^"]*","title":"[^"]*"}' | sed 's/{"name":"\([^"]*\)","title":"\([^"]*\)"}/\1|\2/')
STAGES

    status "Starting Suplex at $URL. Press Ctrl-C to stop it."
    ( for _ in $(seq 1 60); do
        curl -fsS -o /dev/null "$URL/health" 2>/dev/null && { open_url "$URL"; exit 0; }
        sleep 1
    done ) &
    "$TARGET" serve </dev/null
}

main "$@"
