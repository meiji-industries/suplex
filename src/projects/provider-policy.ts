import { z } from "zod";
import { HarnessKindSchema } from "../runtimes/harness-kind.js";

export const ProjectProviderPolicySchema = z.object({
  allowedProviders: z.array(HarnessKindSchema),
  allowedInstanceIds: z.array(z.string().min(1)),
}).strict();
export type ProjectProviderPolicy = z.infer<typeof ProjectProviderPolicySchema>;

/**
 * Each policy row is one credential: a provider row is the system-wide login,
 * an instance row is a dedicated login. A profile uses exactly one of them.
 */
export function isProfileAllowed(policy: ProjectProviderPolicy | null | undefined, profile: { provider: z.infer<typeof HarnessKindSchema>; providerInstanceId?: string | null | undefined }): boolean {
  if (!policy) return true;
  if (profile.providerInstanceId) return policy.allowedInstanceIds.includes(profile.providerInstanceId);
  return policy.allowedProviders.includes(profile.provider);
}

export function assertProfileAllowed(policy: ProjectProviderPolicy | null | undefined, profile: Parameters<typeof isProfileAllowed>[1]): void {
  if (!isProfileAllowed(policy, profile)) throw new Error("Select an agent with a provider and login allowed by this project");
}
