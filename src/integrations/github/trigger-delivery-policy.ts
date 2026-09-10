import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { GithubTriggerDispatchPolicySchema } from "./trigger-dispatches.js";
import { ReviewRangeSchema, type ReviewRange } from "../../coordination/workflows.js";

const Sha = z.string().regex(/^[a-f0-9]{40,64}$/i);
type Row = { id: string; task_id: string | null; repository_id: number; repository_name: string; pull_request_number: number; policy_json: string };
export type GithubTriggerDeliveryPolicy = Pick<z.infer<typeof GithubTriggerDispatchPolicySchema>, "headSha" | "baseSha" | "headBranch" | "baseBranch" | "protectedPaths"> & { dispatchId: string; repositoryId: number; repositoryName: string; pullRequestNumber: number };

function policy(db: Database.Database, taskId: string, dispatchId?: string): GithubTriggerDeliveryPolicy | null {
  const row = db.prepare(`SELECT id, task_id, repository_id, repository_name, pull_request_number, policy_json FROM forge_github_trigger_dispatches WHERE task_id = ?${dispatchId ? " AND id = ?" : ""}`).get(taskId, ...(dispatchId ? [dispatchId] : [])) as Row | undefined;
  if (!row) return null;
  if (row.task_id !== taskId) throw new Error("GitHub trigger dispatch task binding is invalid");
  const parsed = GithubTriggerDispatchPolicySchema.parse(JSON.parse(row.policy_json));
  if (parsed.repositoryId !== row.repository_id || parsed.repositoryName !== row.repository_name.toLowerCase()) throw new Error("GitHub trigger dispatch policy identity is invalid");
  return { dispatchId: z.string().parse(row.id), repositoryId: z.number().int().positive().parse(row.repository_id), repositoryName: z.string().min(1).parse(row.repository_name).toLowerCase(), pullRequestNumber: z.number().int().positive().parse(row.pull_request_number), headSha: parsed.headSha, baseSha: parsed.baseSha, headBranch: parsed.headBranch, baseBranch: parsed.baseBranch, protectedPaths: parsed.protectedPaths };
}
export function triggerDeliveryPolicy(db: Database.Database, taskId: string): GithubTriggerDeliveryPolicy | null { return policy(db, taskId); }
export function recordTriggerPush(db: Database.Database, input: { taskId: string; dispatchId: string; fromHeadSha: string; toHeadSha: string; review: unknown }): void {
  db.transaction(() => { const from = Sha.parse(input.fromHeadSha); const to = Sha.parse(input.toHeadSha); const review: ReviewRange = ReviewRangeSchema.parse(input.review); const value = policy(db, input.taskId, input.dispatchId); if (!value || from === to || review.headSha !== to) throw new Error("GitHub trigger delivery transition is invalid"); const existing = db.prepare("SELECT task_id, from_head_sha, review_json FROM forge_github_trigger_delivery_operations WHERE dispatch_id = ? AND to_head_sha = ?").get(input.dispatchId, to) as { task_id: string; from_head_sha: string; review_json: string } | undefined; if (existing) { if (existing.task_id === input.taskId && existing.from_head_sha === from && JSON.stringify(ReviewRangeSchema.parse(JSON.parse(existing.review_json))) === JSON.stringify(review)) return; throw new Error("GitHub trigger delivery transition conflicts"); } db.prepare("INSERT INTO forge_github_trigger_delivery_operations (id, task_id, dispatch_id, from_head_sha, to_head_sha, review_json, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(`github_trigger_delivery_${randomUUID().replaceAll("-", "")}`, input.taskId, input.dispatchId, from, to, JSON.stringify(review), new Date().toISOString()); }).immediate();
}
