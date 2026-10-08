import type { AuthEnvelope } from "../../../contracts/generated/AuthEnvelope.js";
import { AuthUserResponseSchema } from "../../../contracts/common.js";
import { readJsonUnchecked, type ApiUser } from "../../../lib/api.js";

export async function saveProfile(profile: Pick<ApiUser, "displayName" | "username" | "avatarSeed" | "title">): Promise<ApiUser> {
  const result = await readJsonUnchecked<AuthEnvelope>("/api/auth/me", { method: "PATCH", body: JSON.stringify(profile) });
  return AuthUserResponseSchema.parse(result.user);
}
