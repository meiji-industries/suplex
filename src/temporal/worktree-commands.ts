import { z } from "zod";

import type { ForgeConfig } from "../config.js";
import { runtimeIdentifiers } from "../runtime-identifiers.js";
import { IssueWorkflowStateSchema, type IssueWorkflowState } from "./issue-contracts.js";
import { issueUpdates } from "./issue-updates.js";
import { connectTemporal } from "./service.js";

const WorktreeCommandInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  actorUserId: z.string().min(1),
  confirmDiscardDirty: z.boolean().optional(),
}).strict();

export type WorktreeCommandInput = z.infer<typeof WorktreeCommandInputSchema>;

export async function executeWorktreeCommand(config: ForgeConfig, workflowId: string, command: "delete_worktree" | "recreate_worktree", input: WorktreeCommandInput): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (!workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this installation scope");
  const validatedInput = WorktreeCommandInputSchema.parse(input);
  const temporalClient = await connectTemporal(config);
  try {
    const handle = temporalClient.client.workflow.getHandle(workflowId);
    return IssueWorkflowStateSchema.parse(await handle.executeUpdate(issueUpdates[command], { args: [validatedInput] }));
  } finally {
    await temporalClient.connection.close();
  }
}
