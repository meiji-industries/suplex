// App Store Connect API client, authenticated with the API key in APPLE_API_KEY, APPLE_API_ISSUER, and APPLE_API_PRIVATE_KEY.
import { createPrivateKey, sign } from "node:crypto";

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function token() {
  const now = Math.floor(Date.now() / 1000);
  const claims = `${encode({ alg: "ES256", kid: process.env.APPLE_API_KEY, typ: "JWT" })}.${encode({ iss: process.env.APPLE_API_ISSUER, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" })}`;
  const signature = sign("sha256", Buffer.from(claims), { key: createPrivateKey(process.env.APPLE_API_PRIVATE_KEY), dsaEncoding: "ieee-p1363" });
  return `${claims}.${signature.toString("base64url")}`;
}

/** Calls the API at path (for example "v1/apps") and returns the parsed body, or null for 204. */
export async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.appstoreconnect.apple.com/${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body && { "content-type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
