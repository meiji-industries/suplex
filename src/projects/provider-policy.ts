import { z } from "zod";
import { HarnessKindSchema } from "../runtimes/harness-kind.js";

export const ProjectProviderPolicySchema = z.object({
  allowedProviders: z.array(HarnessKindSchema).min(1),
  allowedInstanceIds: z.array(z.string().min(1)),
}).strict();
export type ProjectProviderPolicy = z.infer<typeof ProjectProviderPolicySchema>;

export function isProfileAllowed(policy: ProjectProviderPolicy | null | undefined, profile: { provider: z.infer<typeof HarnessKindSchema>; providerInstanceId?: string | null | undefined }): boolean {
  if (!policy) return true;
  if (!policy.allowedProviders.includes(profile.provider)) return false;
  if (profile.providerInstanceId) return policy.allowedInstanceIds.includes(profile.providerInstanceId);
  return profile.provider !== "claude-code";
}

export function assertProfileAllowed(policy: ProjectProviderPolicy | null | undefined, profile: Parameters<typeof isProfileAllowed>[1]): void {
  if (!isProfileAllowed(policy, profile)) throw new Error("Select an agent with a provider and login allowed by this project");
}
