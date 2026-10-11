#!/bin/sh
# Tauri runs this for each file to sign (bundle.windows.signCommand) inside the Windows build container.
# Authenticode signing through Azure Trusted Signing with jsign, as sign.bat does with signtool on the VM.
#
#   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET   the service principal
#   AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, AZURE_CERTIFICATE_PROFILE
set -eu
file="${1:?Usage: sign-linux.sh <file>}"
token="$(curl -fsS --max-time 60 \
  --data-urlencode "grant_type=client_credentials" --data-urlencode "client_id=$AZURE_CLIENT_ID" \
  --data-urlencode "client_secret=$AZURE_CLIENT_SECRET" --data-urlencode "scope=https://codesigning.azure.net/.default" \
  "https://login.microsoftonline.com/$AZURE_TENANT_ID/oauth2/v2.0/token" \
  | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).access_token)')"
# jsign takes the endpoint's host name, not the URL.
endpoint="$(printf %s "$AZURE_SIGNING_ENDPOINT" | sed -E 's#^https?://##; s#/.*$##')"
echo "Signing: $file"
# A stalled signing or timestamp connection fails the build instead of hanging it.
timeout 600 jsign --storetype TRUSTEDSIGNING --keystore "$endpoint" --storepass "$token" \
  --alias "$AZURE_SIGNING_ACCOUNT/$AZURE_CERTIFICATE_PROFILE" \
  --tsaurl http://timestamp.acs.microsoft.com --tsmode RFC3161 --alg SHA-256 "$file"
