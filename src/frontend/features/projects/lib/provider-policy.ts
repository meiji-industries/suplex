import type { HarnessKind } from "../../../contracts/generated/HarnessKind.js";
import type { ProjectProviderPolicy } from "../../../contracts/generated/ProjectProviderPolicy.js";

export function isProfileAllowed(policy: ProjectProviderPolicy | null | undefined, profile: { provider: HarnessKind; providerInstanceId?: string | null | undefined }): boolean {
  if (!policy) return true;
  if (profile.providerInstanceId) return policy.allowedInstanceIds.includes(profile.providerInstanceId);
  return policy.allowedProviders.includes(profile.provider);
}
