// Uploads a signed Android App Bundle to Google Play and releases it on SUPLEX_PLAY_TRACK (default internal).
// Usage: node scripts/publish-play.mjs <bundle.aab> <version>, with GOOGLE_PLAY_SERVICE_ACCOUNT_JSON set.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const [bundlePath, version] = process.argv.slice(2);
const track = process.env.SUPLEX_PLAY_TRACK || "internal";
const account = JSON.parse(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
const app = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/sh.suplex.mobile";
const upload = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/sh.suplex.mobile";

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const claims = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: account.client_email, scope: "https://www.googleapis.com/auth/androidpublisher", aud: account.token_uri, iat: now, exp: now + 3600 })}`;
const assertion = `${claims}.${createSign("RSA-SHA256").update(claims).sign(account.private_key, "base64url")}`;
const { access_token } = await call(account.token_uri, { method: "POST", body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) }, false);

async function call(url, init, authorized = true) {
  const headers = { ...init.headers, ...(authorized && { authorization: `Bearer ${access_token}` }) };
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new Error(`${init.method} ${url} failed with ${response.status}: ${await response.text()}`);
  return response.json();
}

const edit = await call(`${app}/edits`, { method: "POST" });
const bundle = await call(`${upload}/edits/${edit.id}/bundles?uploadType=media`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: readFileSync(bundlePath) });
await call(`${app}/edits/${edit.id}/tracks/${track}`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ track, releases: [{ name: version, versionCodes: [String(bundle.versionCode)], status: "completed" }] }),
});
await call(`${app}/edits/${edit.id}:commit`, { method: "POST" });
console.log(`Released Suplex ${version} (version code ${bundle.versionCode}) on the Play ${track} track.`);
