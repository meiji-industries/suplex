#!/usr/bin/env bash

onepassword_token_file="${OP_SERVICE_ACCOUNT_TOKEN_FILE:-$HOME/.config/suplex/op-service-account-token}"
onepassword_token_reference="op://Suplex/f2dxilmlrjfzwz42yzxv4jivki/credential"

onepassword_setup_service_account() {
  command -v op >/dev/null || { echo "Install the 1Password CLI (op)." >&2; return 1; }

  local token
  if [[ -s "$onepassword_token_file" ]]; then
    token="$(<"$onepassword_token_file")"
  else
    token="$(env -u OP_SERVICE_ACCOUNT_TOKEN op read --account my "$onepassword_token_reference")" || {
      echo "Sign in to 1Password, then rerun: mise run _1password:setup" >&2
      return 1
    }
    mkdir -p "$(dirname "$onepassword_token_file")"
    umask 077
    printf '%s\n' "$token" >"$onepassword_token_file"
    chmod 600 "$onepassword_token_file"
  fi

  OP_SERVICE_ACCOUNT_TOKEN="$token" op vault get Suplex >/dev/null || {
    echo "The service account cannot access the Suplex vault." >&2
    return 1
  }
  export OP_SERVICE_ACCOUNT_TOKEN="$token"
}
