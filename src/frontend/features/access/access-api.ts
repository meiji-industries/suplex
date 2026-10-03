import { z } from "zod";
import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";

import type { AccessResponse } from "../../contracts/generated/AccessResponse.js";
import type { AuthOptions } from "../../contracts/generated/AuthOptions.js";
import type { RemoteAccessPolicy } from "../../contracts/generated/RemoteAccessPolicy.js";
import { readJson } from "../../lib/api.js";

const UserSchema = z.object({ id: z.string(), displayName: z.string(), title: z.string(), username: z.string(), avatarSeed: z.string(), role: z.string(), status: z.string(), companyIds: z.array(z.string()) });
const CredentialSchema = z.object({ id: z.string(), userId: z.string(), credentialId: z.string(), label: z.string(), rpId: z.string().nullable(), createdAt: z.string(), revokedAt: z.string().nullable() });
const PolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open"), requireHttps: z.boolean(), defaultUserId: z.string(), externalHttpsOrigin: z.string().nullable() }),
  z.object({ kind: z.literal("passkeys"), externalHttpsOrigin: z.string().nullable() }),
]);
const AccessSchema: z.ZodType<AccessResponse> = z.object({ policy: PolicySchema, users: z.array(UserSchema), credentials: z.array(CredentialSchema), httpsOrigin: z.string().nullable(), networkMode: z.enum(["local", "tailscale", "all"]).nullable() });
const AuthOptionsSchema: z.ZodType<AuthOptions> = z.object({
  challengeId: z.string(),
  options: z.unknown(),
});
const CreationOptionsSchema = z.custom<PublicKeyCredentialCreationOptionsJSON>((value) => typeof value === "object" && value !== null);

export async function readAccess(signal?: AbortSignal): Promise<AccessResponse> {
  return AccessSchema.parse(await readJson("/api/admin/access", signal ? { signal } : undefined));
}

export async function saveAccess(policy: RemoteAccessPolicy): Promise<AccessResponse> {
  return AccessSchema.parse(await readJson("/api/admin/access", { method: "PUT", body: JSON.stringify(policy) }));
}

export async function beginPasskey(): Promise<AuthOptions & { options: PublicKeyCredentialCreationOptionsJSON }> {
  const envelope = AuthOptionsSchema.parse(await readJson("/api/auth/passkeys/options", { method: "POST", body: "{}" }));
  return { ...envelope, options: CreationOptionsSchema.parse(envelope.options) };
}

export async function finishPasskey(challengeId: string, label: string, response: RegistrationResponseJSON): Promise<void> {
  await readJson("/api/auth/passkeys/verify", { method: "POST", body: JSON.stringify({ challengeId, label, response }) });
}

export async function renamePasskey(id: string, label: string): Promise<void> {
  await readJson(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ label }) });
}

export async function removePasskey(id: string): Promise<void> {
  await readJson(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function revokePasskey(id: string): Promise<void> {
  await readJson(`/api/admin/credentials/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" });
}
