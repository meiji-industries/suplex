import type { WebPushKeyResponse } from "../../../contracts/generated/WebPushKeyResponse.js";
import { readJson, readJsonUnchecked } from "../../../lib/api.js";

export function readWebPushKey(): Promise<WebPushKeyResponse> {
  return readJsonUnchecked<WebPushKeyResponse>("/api/web-push/key");
}

export async function saveWebPushSubscription(subscription: PushSubscription): Promise<void> {
  await readJson("/api/web-push/subscription", { method: "PUT", body: JSON.stringify(subscription.toJSON()) });
}

export async function deleteWebPushSubscription(endpoint: string): Promise<void> {
  await readJson("/api/web-push/subscription", { method: "DELETE", body: JSON.stringify({ endpoint }) });
}

/** True when this browser can receive Web Push. The desktop app cannot. */
export function webPushSupported(): boolean {
  return !window.suplexApp && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Sends this browser's current subscription to the host again, so the host copy heals after a restore or a new sign-in. */
export async function refreshWebPushSubscription(): Promise<void> {
  if (!webPushSupported() || Notification.permission !== "granted") return;
  const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  if (subscription) await saveWebPushSubscription(subscription);
}

/** Decodes a base64url key, with or without padding, for `applicationServerKey`. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
