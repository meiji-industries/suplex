import { useState } from "react";
import type { ApiUser } from "../../../lib/api.js";

type ProfileDraft = Pick<ApiUser, "displayName" | "username" | "title" | "avatarSeed">;

export function profileDefaults(user: ApiUser | undefined, email?: string): ProfileDraft {
  const localPart = email?.split("@")[0] ?? "";
  const isOperator = user?.id === "user_development";
  return {
    displayName: isOperator && user.displayName === "Operator" ? "" : user?.displayName ?? "",
    username: isOperator && user.username === "operator@suplex.local" ? localPart : user?.username ?? "",
    title: user?.title ?? "",
    avatarSeed: isOperator && user.avatarSeed === "operator@suplex.local" ? localPart : user?.avatarSeed ?? "",
  };
}

export function useProfileDraft(user: ApiUser | undefined, email?: string) {
  const [draft, setDraft] = useState<Partial<ProfileDraft>>({});
  const profile = { ...profileDefaults(user, email), ...draft };
  const changeProfile = (changes: Partial<ProfileDraft>): void => setDraft(previous => ({ ...previous, ...changes }));
  return { profile, changeProfile };
}
