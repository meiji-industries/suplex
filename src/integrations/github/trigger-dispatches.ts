import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type { ForgeDatabase } from "../../platform/database.js";
import { validateGithubTriggerProtectedPaths } from "./trigger-paths.js";
import { DeliveryTargetSchema, TaskConfigurationSchema, TaskInputSchema, type TaskRequest } from "../../tasks/contracts.js";
import { TaskProfileSchema, type TaskProfile } from "../../tasks/control.js";
import { taskRequestHash } from "../../tasks/repository.js";
import { normalizeWorkflowInput, workflowDefinition } from "../../coordination/workflows.js";
import { WorkflowRecordSchema, type WorkflowRecord } from "../../http/contracts/workflows.js";

const sha = z.string().regex(/^[a-f0-9]{40,64}$/i);
const branch = z.string().min(1).regex(/^(?![./])(?!.*(?:\.\.|\.$|\.lock$|\/\/|\s|[~^:?*\[\\]))[A-Za-z0-9._/-]+$/);
export const GithubTriggerDispatchPolicySchema = z.object({ headSha: sha, baseSha: sha, headBranch: branch, baseBranch: branch, protectedPaths: z.array(z.string()), repositoryId: z.number().int().positive(), repositoryName: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9][a-z0-9_.-]{0,99}$/i).transform(value => value.toLowerCase()), deliveryTarget: DeliveryTargetSchema }).strict();
const Row = z.object({ id: z.string(), rule_id: z.string(), company_id: z.string(), project_id: z.string(), repository_id: z.number(), repository_name: z.string(), pull_request_number: z.number(), authority_user_id: z.string(), request_json: z.string(), policy_json: z.string(), preset_json: z.string(), profiles_json: z.string(), idempotency_key: z.string(), task_id: z.string().nullable(), created_at: z.string(), updated_at: z.string() });

export type GithubTriggerDispatch = { id: string; ruleId: string; companyId: string; projectId: string; repositoryId: number; repositoryName: string; pullRequestNumber: number; authorityUserId: string; request: TaskRequest; policy: z.infer<typeof GithubTriggerDispatchPolicySchema>; preset: WorkflowRecord; profiles: { root: TaskProfile; worker: TaskProfile; advisors: Record<string, TaskProfile> }; idempotencyKey: string; taskId: string | null; createdAt: string; updatedAt: string };
export type GithubTriggerDispatchPrepare = Omit<GithubTriggerDispatch, "id" | "idempotencyKey" | "taskId" | "createdAt" | "updatedAt" | "request"> & { request: Omit<TaskRequest, "idempotencyKey" | "startImmediately"> };

function dispatch(raw: unknown): GithubTriggerDispatch {
  const row = Row.parse(raw);
  return { id: row.id, ruleId: row.rule_id, companyId: row.company_id, projectId: row.project_id, repositoryId: row.repository_id, repositoryName: row.repository_name, pullRequestNumber: row.pull_request_number, authorityUserId: row.authority_user_id, request: TaskInputSchema.parse(JSON.parse(row.request_json)), policy: GithubTriggerDispatchPolicySchema.parse(JSON.parse(row.policy_json)), preset: WorkflowRecordSchema.parse(JSON.parse(row.preset_json)), profiles: z.object({ root: TaskProfileSchema, worker: TaskProfileSchema, advisors: z.record(z.string(), TaskProfileSchema) }).parse(JSON.parse(row.profiles_json)), idempotencyKey: row.idempotency_key, taskId: row.task_id, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class GithubTriggerDispatchRepository {
  constructor(private readonly database: ForgeDatabase) {}
  prepare(input: GithubTriggerDispatchPrepare): GithubTriggerDispatch {
    return this.database.authImmediateTransaction(db => {
    const existingRow = db.prepare("SELECT * FROM forge_github_trigger_dispatches WHERE rule_id = ? AND repository_id = ? AND pull_request_number = ?").get(input.ruleId, input.repositoryId, input.pullRequestNumber);
    if (existingRow) {
      const existing = dispatch(existingRow);
      if (existing.companyId !== input.companyId || existing.projectId !== input.projectId || existing.repositoryName !== input.repositoryName.toLowerCase() || existing.authorityUserId !== input.authorityUserId) throw new Error("GitHub trigger dispatch binding does not match capture");
      return existing;
    }
    const policy = GithubTriggerDispatchPolicySchema.parse(input.policy);
    const preset = WorkflowRecordSchema.parse(input.preset);
    const profiles = z.object({ root: TaskProfileSchema, worker: TaskProfileSchema, advisors: z.record(z.string(), TaskProfileSchema) }).parse(input.profiles);
    const rule = db.prepare("SELECT company_id, project_id, repository_id, repository_name, authority_user_id, workflow_id, delivery_target, protected_paths_json FROM forge_github_trigger_rules WHERE id = ?").get(input.ruleId) as { company_id: string; project_id: string; repository_id: number; repository_name: string; authority_user_id: string; workflow_id: string; delivery_target: string; protected_paths_json: string } | undefined;
    if (!rule || rule.company_id !== input.companyId || rule.project_id !== input.projectId || rule.repository_id !== input.repositoryId || rule.repository_name.toLowerCase() !== input.repositoryName.toLowerCase() || rule.authority_user_id !== input.authorityUserId || rule.workflow_id !== preset.id || rule.delivery_target !== policy.deliveryTarget || JSON.stringify(JSON.parse(rule.protected_paths_json)) !== JSON.stringify(policy.protectedPaths)) throw new Error("GitHub trigger dispatch does not match rule");
    validateGithubTriggerProtectedPaths(policy.protectedPaths);
    if (policy.repositoryId !== input.repositoryId || policy.repositoryName.toLowerCase() !== input.repositoryName.toLowerCase() || policy.deliveryTarget !== input.request.deliveryTarget || input.request.projectId !== input.projectId || input.request.source?.kind !== "pull_request" || input.request.source.number !== input.pullRequestNumber) throw new Error("GitHub trigger dispatch capture is contradictory");
    const normalized = normalizeWorkflowInput({ ...input.request, startImmediately: false, source: input.request.source }, { requireSource: true });
    const id = `github_trigger_dispatch_${randomUUID().replaceAll("-", "")}`;
    const key = `github-trigger:${id}`;
    const request = TaskInputSchema.parse({ ...normalized, idempotencyKey: key, startImmediately: false });
    if (profiles.root.profileId !== request.rootProfileId || profiles.worker.profileId !== request.workerProfileId || request.workflow !== preset.engine) throw new Error("GitHub trigger dispatch profiles do not match request");
    if ((preset.rootProfileId !== undefined && preset.rootProfileId !== request.rootProfileId) || (preset.workerProfileId !== undefined && preset.workerProfileId !== request.workerProfileId) || (preset.runProjectTests !== undefined && preset.runProjectTests !== request.runProjectTests) || (preset.visualEvidence !== undefined && preset.visualEvidence !== request.visualEvidence)) throw new Error("GitHub trigger dispatch does not match preset");
    const roles = workflowDefinition(request.workflow).advisorRoles;
    const requestedRoles = Object.keys(request.advisorProfileIds).sort();
    const capturedRoles = Object.keys(profiles.advisors).sort();
    if (JSON.stringify(requestedRoles) !== JSON.stringify([...roles].sort()) || JSON.stringify(capturedRoles) !== JSON.stringify([...roles].sort()) || roles.some(role => request.advisorProfileIds[role] !== profiles.advisors[role]?.profileId || !request.advisorProfileIds[role] || (preset.advisorProfileIds[role] !== undefined && preset.advisorProfileIds[role] !== request.advisorProfileIds[role]))) throw new Error("GitHub trigger dispatch Advisors do not match request");
    const now = new Date().toISOString();
    const value: GithubTriggerDispatch = { ...input, repositoryName: input.repositoryName.toLowerCase(), id, idempotencyKey: key, taskId: null, request, policy, preset, profiles, createdAt: now, updatedAt: now };
    db.prepare("INSERT INTO forge_github_trigger_dispatches (id, rule_id, company_id, project_id, repository_id, repository_name, pull_request_number, authority_user_id, request_json, policy_json, preset_json, profiles_json, idempotency_key, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)").run(value.id, value.ruleId, value.companyId, value.projectId, value.repositoryId, value.repositoryName.toLowerCase(), value.pullRequestNumber, value.authorityUserId, JSON.stringify(value.request), JSON.stringify(value.policy), JSON.stringify(value.preset), JSON.stringify(value.profiles), value.idempotencyKey, now, now);
    return value;
    });
  }
  get(id: string): GithubTriggerDispatch | null { const row = this.database.authQuery(db => db.prepare("SELECT * FROM forge_github_trigger_dispatches WHERE id = ?").get(id)); return row ? dispatch(row) : null; }
  find(ruleId: string, repositoryId: number, pullRequestNumber: number): GithubTriggerDispatch | null { const row = this.database.authQuery(db => db.prepare("SELECT * FROM forge_github_trigger_dispatches WHERE rule_id = ? AND repository_id = ? AND pull_request_number = ?").get(ruleId, repositoryId, pullRequestNumber)); return row ? dispatch(row) : null; }
  listByRule(companyId: string, ruleId: string): GithubTriggerDispatch[] { return this.database.authQuery(db => db.prepare("SELECT * FROM forge_github_trigger_dispatches WHERE company_id = ? AND rule_id = ? ORDER BY created_at, id").all(companyId, ruleId).map(dispatch)); }
  unfinished(): GithubTriggerDispatch[] { return this.database.authQuery(db => db.prepare("SELECT * FROM forge_github_trigger_dispatches WHERE task_id IS NULL ORDER BY created_at, id").all().map(dispatch)); }
  previouslyProcessed(repositoryId: number, pullRequestNumber: number): boolean { return this.database.authQuery(db => Boolean(db.prepare("SELECT 1 FROM forge_github_trigger_dispatches WHERE repository_id = ? AND pull_request_number = ? LIMIT 1").get(repositoryId, pullRequestNumber))); }
  linkTask(dispatchId: string, taskId: string): GithubTriggerDispatch {
    return this.database.authImmediateTransaction(db => {
      const current = this.get(dispatchId); if (!current) throw new Error("GitHub trigger dispatch was not found");
      if (current.taskId) { if (current.taskId !== taskId) throw new Error("GitHub trigger dispatch already links another task"); return current; }
      const task = db.prepare("SELECT t.company_id, t.project_id, t.idempotency_key, t.request_hash, t.creator_user_id, t.creator_agent_id, t.configuration_json, t.archived_at, c.status, c.delivery_target, c.workflow, c.root_profile_json, c.worker_profile_json, c.advisor_profiles_json FROM forge_tasks t JOIN forge_task_controls c ON c.task_id = t.id WHERE t.id = ?").get(taskId) as { company_id: string; project_id: string; idempotency_key: string; request_hash: string; creator_user_id: string | null; creator_agent_id: string | null; configuration_json: string; archived_at: string | null; status: string; delivery_target: string; workflow: string; root_profile_json: string; worker_profile_json: string; advisor_profiles_json: string } | undefined;
      if (!task || task.archived_at || task.status !== "backlog" || task.company_id !== current.companyId || task.project_id !== current.projectId || task.idempotency_key !== current.idempotencyKey || task.creator_user_id !== current.authorityUserId || task.creator_agent_id !== null || task.request_hash !== taskRequestHash(current.request, { kind: "user", id: current.authorityUserId })) throw new Error("Task does not match GitHub trigger dispatch");
      const config = TaskConfigurationSchema.parse(JSON.parse(task.configuration_json));
      if (config.repository.toLowerCase() !== current.repositoryName || config.source?.kind !== "pull_request" || config.source.number !== current.pullRequestNumber || config.startingSha !== current.policy.headSha || config.baselineSha !== current.policy.baseSha || config.branch !== current.policy.headBranch || config.baseBranch !== current.policy.baseBranch || config.runProjectTests !== current.request.runProjectTests || config.visualEvidence !== current.request.visualEvidence || task.delivery_target !== current.policy.deliveryTarget || task.workflow !== current.request.workflow) throw new Error("Task configuration does not match GitHub trigger dispatch");
      const profiles = { root: TaskProfileSchema.parse(JSON.parse(task.root_profile_json)), worker: TaskProfileSchema.parse(JSON.parse(task.worker_profile_json)), advisors: z.record(z.string(), TaskProfileSchema).parse(JSON.parse(task.advisor_profiles_json)) };
      if (!isDeepStrictEqual(profiles, current.profiles)) throw new Error("Task profiles do not match GitHub trigger dispatch");
      db.prepare("UPDATE forge_github_trigger_dispatches SET task_id = ?, updated_at = ? WHERE id = ? AND (task_id IS NULL OR task_id = ?)").run(taskId, new Date().toISOString(), dispatchId, taskId);
      return this.get(dispatchId)!;
    });
  }
}
