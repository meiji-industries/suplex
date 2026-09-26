import { z } from "zod";

import { HarnessKindSchema } from "./harness-kind.js";

export const ProjectProviderPolicySchema = z.object({
  allowedProviders: z.array(HarnessKindSchema),
  allowedInstanceIds: z.array(z.string().min(1)),
}).strict();

export type ProjectProviderPolicy = z.infer<typeof ProjectProviderPolicySchema>;
