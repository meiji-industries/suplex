import { z } from "zod";

export const TaskBranchSyncResponseSchema = z.union([
  z.object({ available: z.literal(false) }),
  z.object({ branchName: z.string(), worktreePath: z.string(), remoteExists: z.boolean(), ahead: z.number().int().nonnegative(), behind: z.number().int().nonnegative(), headSha: z.string().regex(/^[a-f0-9]{40,64}$/i) }),
]);
export type TaskBranchSyncResponse = z.infer<typeof TaskBranchSyncResponseSchema>;
