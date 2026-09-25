import type { ProjectProviderPolicy } from "./provider-policy-contracts.js";
import type { HarnessKind } from "../runtimes/harness-kind.js";
export { ProjectProviderPolicySchema } from "./provider-policy-contracts.js";
export type { ProjectProviderPolicy } from "./provider-policy-contracts.js";

/**
 * Each policy row is one credential: a provider row is the system-wide login,
 * an instance row is a dedicated login. A profile uses exactly one of them.
 */
export function isProfileAllowed(policy: ProjectProviderPolicy | null | undefined, profile: { provider: HarnessKind; providerInstanceId?: string | null | undefined }): boolean {
  if (!policy) return true;
  if (profile.providerInstanceId) return policy.allowedInstanceIds.includes(profile.providerInstanceId);
  return policy.allowedProviders.includes(profile.provider);
}

export function assertProfileAllowed(policy: ProjectProviderPolicy | null | undefined, profile: Parameters<typeof isProfileAllowed>[1]): void {
  if (!isProfileAllowed(policy, profile)) throw new Error("Select an agent with a provider and login allowed by this project");
}
