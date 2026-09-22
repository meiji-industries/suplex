import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { AuthFailure, type AuthService } from "../../identity/auth.js";
import type { SuplexDatabase } from "../../platform/database.js";
import { GithubReleaseFailure } from "./failure.js";
import type { GithubTriggerPort, GithubTriggerPullRequestInspection } from "./trigger-inspection.js";
import { matchesGithubTriggerProtectedPaths, validateGithubTriggerProtectedPaths } from "./trigger-paths.js";
import { GithubTriggerRepository } from "./trigger-repository.js";
import { GithubTriggerDispatchRepository } from "./trigger-dispatches.js";
import { assertPullRequestAvailable } from "../../delivery/pull-request-ownership.js";
import { GithubTriggerCreateSchema, GithubTriggerPatchSchema, type GithubTriggerActivity, type GithubTriggerCreate, type GithubTriggerPatch, type GithubTriggerRule } from "../../http/contracts/github-triggers.js";
import type { Project, ProjectService } from "../../projects/projects.js";
import { TaskProfileSchema, type TaskProfile } from "../../tasks/control.js";
import type { WorkflowRecord } from "../../http/contracts/workflows.js";
import type { WorkflowRecordService } from "../../coordination/workflow-records.js";
import type { TaskService } from "../../tasks/tasks.js";
import { normalizeWorkflowInput, workflowDefinition, WorkflowInputFailure } from "../../coordination/workflows.js";

type Projects = Pick<ProjectService, "getProjectInCompany">;
type Workflows = Pick<WorkflowRecordService, "get">;
type Config = Pick<GithubTriggerRule, "projectId" | "name" | "label" | "workflowId" | "deliveryTarget" | "protectedPaths" | "authorityUserId">;
type OperationDependencies = {
  project: Pick<Project, "repositoryPath" | "worktreeRoot" | "baseBranch" | "setupCommand" | "verificationCommand"> & { repository: string };
  workflow: { engine: WorkflowRecord["engine"]; runProjectTests: boolean; visualEvidence: NonNullable<WorkflowRecord["visualEvidence"]> };
  profiles: TaskProfile[];
};
type Local = { repository: string; baseBranch: string; dependencies: OperationDependencies; preset: WorkflowRecord };
type Tasks = Pick<TaskService, "createTaskFromGithubTrigger" | "startTaskFromGithubTrigger" | "getTask">;

class PreviewFailure extends AuthFailure {
  constructor(readonly retryAt: string | null) { super("GitHub could not complete this check.", 502); }
}

function timestamp(): string { return new Date().toISOString(); }
function message(error: unknown): { text: string; retryAt: string | null } {
  if (error instanceof PreviewFailure) return { text: error.publicMessage, retryAt: error.retryAt };
  if (error instanceof GithubReleaseFailure) return { text: error.code === "authentication-required" ? "GitHub could not authenticate this request." : error.code === "provider-rate-limited" ? "GitHub checks are delayed." : "GitHub could not complete this check.", retryAt: error.retryAt };
  return { text: error instanceof AuthFailure ? error.publicMessage : "GitHub could not complete this check.", retryAt: null };
}

export class GithubTriggerService {
  readonly repository: GithubTriggerRepository;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly database: SuplexDatabase, private readonly auth: AuthService, private readonly projects: Projects, private readonly workflows: Workflows, private readonly github: GithubTriggerPort, private readonly tasks?: Tasks) { this.repository = new GithubTriggerRepository(database); }

  list(userId: string, companyId: string): GithubTriggerRule[] { this.admin(userId, companyId); return this.repository.list(companyId); }
  activity(userId: string, companyId: string, ruleId: string): GithubTriggerActivity[] {
    this.admin(userId, companyId); this.rule(companyId, ruleId);
    const activity = this.repository.activity(companyId, ruleId);
    const seen = new Set(activity.map(value => value.taskId).filter((value): value is string => value !== null));
    for (const dispatch of new GithubTriggerDispatchRepository(this.database).listByRule(companyId, ruleId)) {
      if (dispatch.taskId && !seen.has(dispatch.taskId)) activity.push({ at: dispatch.updatedAt, pullRequestNumber: dispatch.pullRequestNumber, url: null, outcome: "eligible", reason: "Backlog task created.", matchingPaths: [], taskId: dispatch.taskId, taskStatus: null, previouslyProcessed: true });
    }
    return activity.map(value => value.taskId && this.tasks ? { ...value, taskStatus: this.tasks.getTask(userId, value.taskId).status } : value);
  }

  async create(userId: string, companyId: string, raw: GithubTriggerCreate): Promise<GithubTriggerRule> {
    const input = GithubTriggerCreateSchema.parse(raw);
    this.admin(userId, companyId);
    const config: Config = { ...input, authorityUserId: userId };
    const local = this.local(userId, companyId, config);
    const binding = await this.provider(local.repository, config.label);
    const time = timestamp();
    const created: GithubTriggerRule = { id: `github_trigger_${randomUUID().replaceAll("-", "")}`, companyId, ...config, repositoryId: binding.id, repositoryName: binding.fullName, enabled: false, archivedAt: null, revision: 1, lastSuccessfulCheckAt: null, nextRetryAt: null, latestError: null, failureCount: 0, createdAt: time, updatedAt: time };
    try { this.repository.insert(created, () => this.sameLocal(userId, companyId, config, local), () => this.auth.recordAuditEventInTransaction(undefined, userId, "github_trigger_created", undefined, companyId, { ruleId: created.id })); } catch (error) { if (error instanceof Error && /UNIQUE constraint failed: suplex_github_trigger_rules_enabled_repository_unique/i.test(error.message)) throw new AuthFailure("An enabled GitHub rule already exists for this repository", 409); throw error; }
    return created;
  }

  async update(userId: string, companyId: string, ruleId: string, raw: GithubTriggerPatch): Promise<GithubTriggerRule> {
    const patch = GithubTriggerPatchSchema.parse(raw);
    this.admin(userId, companyId);
    const current = this.rule(companyId, ruleId);
    if (patch.expectedRevision !== current.revision) throw new AuthFailure("This GitHub rule changed. Refresh and try again.", 409);
    const configKeys = ["projectId", "name", "label", "workflowId", "deliveryTarget", "protectedPaths"].filter(key => patch[key as keyof GithubTriggerPatch] !== undefined);
    const stop = patch.enabled === false || patch.archived === true;
    if (stop) {
      if (configKeys.length || patch.archived === false) throw new AuthFailure("Stop or archive a rule separately from configuration changes", 422);
      return this.write(userId, current, { ...current, enabled: false, archivedAt: patch.archived ? timestamp() : current.archivedAt, revision: current.revision + 1, updatedAt: timestamp() }, current.revision);
    }
    if (patch.archived === false && patch.enabled === true) throw new AuthFailure("Restore a rule before enabling it", 422);
    if (patch.archived === false) return this.write(userId, current, { ...current, enabled: false, archivedAt: null, revision: current.revision + 1, updatedAt: timestamp() }, current.revision);
    const config: Config = { projectId: patch.projectId ?? current.projectId, name: patch.name ?? current.name, label: patch.label ?? current.label, workflowId: patch.workflowId ?? current.workflowId, deliveryTarget: patch.deliveryTarget ?? current.deliveryTarget, protectedPaths: patch.protectedPaths ?? current.protectedPaths, authorityUserId: userId };
    const local = this.local(userId, companyId, config);
    const binding = await this.provider(local.repository, config.label);
    const changedBinding = binding.id !== current.repositoryId || binding.fullName !== current.repositoryName;
    if (current.enabled && changedBinding) throw new AuthFailure("Disable this rule before changing its repository binding", 409);
    if (changedBinding && patch.enabled === true) throw new AuthFailure("Save the new repository binding before enabling this rule", 422);
    const next: GithubTriggerRule = { ...current, ...config, repositoryId: binding.id, repositoryName: binding.fullName, enabled: patch.enabled ?? current.enabled, revision: current.revision + 1, updatedAt: timestamp() };
    return this.write(userId, current, next, current.revision, () => this.sameLocal(userId, companyId, config, local));
  }

  check(userId: string, companyId: string, ruleId: string): Promise<GithubTriggerActivity[]> {
    const run = async () => this.preview(userId, companyId, ruleId);
    return this.enqueue(run);
  }

  processEnabledRules(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.tasks) return;
      for (const rule of this.repository.enabledDue()) {
        try { await this.dispatch(rule); } catch { /* Each repository has its own retry state. */ }
      }
    });
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async preview(userId: string, companyId: string, ruleId: string): Promise<GithubTriggerActivity[]> {
    this.admin(userId, companyId);
    const rule = this.rule(companyId, ruleId);
    if (rule.archivedAt) throw new AuthFailure("This GitHub rule is archived", 409);
    const config: Config = rule;
    const activity: GithubTriggerActivity[] = [];
    try {
      const local = this.local(userId, companyId, config);
      const binding = await this.provider(local.repository, rule.label);
      const current = this.rule(companyId, ruleId);
      if (current.revision !== rule.revision) throw new AuthFailure("This GitHub rule changed. Refresh and try again.", 409);
      if (binding.id !== rule.repositoryId || binding.fullName !== rule.repositoryName) {
        if (!this.repository.record(rule, rule.revision, [], false, "Repository binding changed. The rule was disabled.", new Date(Date.now() + 60_000).toISOString(), true, () => this.sameLocal(userId, companyId, config, local))) throw new AuthFailure("This GitHub rule changed. Refresh and try again.", 409);
        throw new AuthFailure("Repository binding changed. The rule was disabled.", 409);
      }
      const candidates = await this.github.listOpenPullRequestsByLabel({ repository: rule.repositoryName, label: rule.label });
      let candidateFailure = false;
      let candidateRetryAt: string | null = null;
      for (const candidate of candidates) {
        try {
          const pull = await this.github.inspectPullRequest({ repository: rule.repositoryName, number: candidate.number });
          const matchingPaths = pull.files.flatMap(file => [file.filename, file.previousFilename].filter((path): path is string => path !== null && matchesGithubTriggerProtectedPaths(rule.protectedPaths, { filename: path } )));
          const sameRepository = pull.baseRepository.id === rule.repositoryId && pull.baseRepository.id === binding.id && pull.baseRepository.fullName.toLowerCase() === rule.repositoryName.toLowerCase() && pull.baseRepository.fullName.toLowerCase() === binding.fullName.toLowerCase();
          const reason = !sameRepository ? "The pull request repository does not match this rule." : pull.state !== "open" ? "The pull request is closed." : pull.isDraft ? "The pull request is a draft." : pull.isCrossRepository ? "The pull request comes from a fork." : pull.baseBranch !== local.baseBranch ? "The pull request targets a different base branch." : !pull.labels.includes(rule.label) ? "The pull request does not have the required label." : matchingPaths.length ? "The pull request changes a protected path." : this.repository.ownsPullRequest(rule.repositoryName, pull.number) ? "A task already uses this pull request." : "Eligible.";
          const dispatch = new GithubTriggerDispatchRepository(this.database).find(rule.id, pull.baseRepository.id, pull.number);
          activity.push({ at: timestamp(), pullRequestNumber: pull.number, url: pull.url, outcome: reason === "Eligible." ? "eligible" : "excluded", reason, matchingPaths, taskId: dispatch?.taskId ?? null, taskStatus: dispatch?.taskId ? this.tasks?.getTask(rule.authorityUserId, dispatch.taskId).status ?? null : null, previouslyProcessed: new GithubTriggerDispatchRepository(this.database).previouslyProcessed(pull.baseRepository.id, pull.number) });
        } catch (error) {
          candidateFailure = true;
          const detail = message(error);
          if (detail.retryAt && (!candidateRetryAt || Date.parse(detail.retryAt) > Date.parse(candidateRetryAt))) candidateRetryAt = detail.retryAt;
          activity.push({ at: timestamp(), pullRequestNumber: candidate.number, url: null, outcome: "error", reason: detail.text, matchingPaths: [], taskId: null, taskStatus: null, previouslyProcessed: false });
        }
      }
      const reread = this.rule(companyId, ruleId);
      if (reread.revision !== rule.revision) throw new AuthFailure("This GitHub rule changed. Refresh and try again.", 409);
      if (candidateFailure) throw new PreviewFailure(candidateRetryAt);
      if (!this.repository.record(rule, rule.revision, activity, true, null, null, false, () => this.sameLocal(userId, companyId, config, local))) throw new AuthFailure("This GitHub rule changed. Refresh and try again.", 409);
      return activity;
    } catch (error) {
      const detail = message(error);
      const delay = Math.min(15 * 60_000, 60_000 * 2 ** Math.min(rule.failureCount, 4));
      const retryAt = detail.retryAt && Date.parse(detail.retryAt) > Date.now() + delay ? detail.retryAt : new Date(Date.now() + delay).toISOString();
      this.repository.record(rule, rule.revision, activity, false, detail.text, retryAt);
      throw error;
    }
  }

  private local(actorUserId: string, companyId: string, config: Config): Local {
    this.admin(actorUserId, companyId);
    const authority = this.auth.getUserForAuthority(config.authorityUserId);
    if (!authority || authority.role !== "admin") throw new AuthFailure("GitHub authority is unavailable", 422);
    const company = this.auth.requireCompanyAccess(config.authorityUserId, companyId);
    if (company.status !== "active") throw new AuthFailure("Company is not active", 409);
    const project = this.projects.getProjectInCompany(companyId, config.projectId);
    if (!project.repository) throw new AuthFailure("Project repository is not configured", 422);
    const workflow = this.workflows.get(config.authorityUserId, config.workflowId);
    if (workflow.archivedAt) throw new AuthFailure("Selected workflow is archived", 422);
    let execution: { workflow: WorkflowRecord["engine"]; runProjectTests: boolean | undefined };
    try {
      const normalized = normalizeWorkflowInput({ workflow: workflow.engine, advisorProfileIds: workflow.advisorProfileIds, deliveryTarget: config.deliveryTarget, runProjectTests: workflow.runProjectTests, source: { kind: "pull_request", number: 1 } }, { requireSource: true });
      execution = { workflow: normalized.workflow, runProjectTests: normalized.runProjectTests };
    }
    catch (error) { if (error instanceof WorkflowInputFailure) throw new AuthFailure(error.message, 422); throw error; }
    const ids: Array<[string, "root" | "worker"]> = [[workflow.rootProfileId ?? project.rootProfileId, "root"], [workflow.workerProfileId ?? project.workerProfileId, "worker"], ...workflowDefinition(workflow.engine).advisorRoles.map(role => [workflow.advisorProfileIds[role] ?? workflow.rootProfileId ?? project.rootProfileId, "root"] as [string, "root" | "worker"])];
    const profiles = ids.map(([id, role]) => {
      const profile = TaskProfileSchema.safeParse(this.database.authQuery(db => db.prepare("SELECT id AS profileId, provider, model, reasoning_level AS reasoningLevel, service_tier AS serviceTier FROM suplex_profiles WHERE id = ? AND role = ? AND archived_at IS NULL").get(id, role)));
      if (!profile.success) throw new AuthFailure("Selected workflow profile is unavailable", 422);
      return profile.data;
    });
    try { validateGithubTriggerProtectedPaths(config.protectedPaths); } catch { throw new AuthFailure("Protected paths are invalid", 422); }
    return {
      repository: project.repository,
      baseBranch: project.baseBranch,
      preset: workflow,
      dependencies: {
        project: { repository: project.repository, repositoryPath: project.repositoryPath, worktreeRoot: project.worktreeRoot, baseBranch: project.baseBranch, setupCommand: project.setupCommand, verificationCommand: project.verificationCommand },
        workflow: { engine: execution.workflow, runProjectTests: execution.runProjectTests ?? true, visualEvidence: workflow.visualEvidence ?? "off" },
        profiles,
      },
    };
  }
  private async dispatch(rule: GithubTriggerRule): Promise<void> {
    const activity: GithubTriggerActivity[] = [];
    let failed = false;
    let providerRetryAt: string | null = null;
    try {
      const local = this.local(rule.authorityUserId, rule.companyId, rule);
      const current = this.rule(rule.companyId, rule.id);
      if (!current.enabled || current.revision !== rule.revision) return;
      const binding = await this.provider(local.repository, rule.label);
      if (binding.id !== rule.repositoryId || binding.fullName.toLowerCase() !== rule.repositoryName.toLowerCase()) {
        this.repository.record(rule, rule.revision, activity, false, "Repository binding changed. The rule was disabled.", new Date(Date.now() + 60_000).toISOString(), true);
        return;
      }
      const dispatches = new GithubTriggerDispatchRepository(this.database);
      for (const pending of dispatches.unfinished().filter(value => value.ruleId === rule.id)) {
        try {
          const pull = await this.github.inspectPullRequest({ repository: pending.repositoryName, number: pending.pullRequestNumber });
          const eligibility = this.eligible(rule, local, pull, pending.policy);
          if (eligibility.reason) { activity.push({ at: timestamp(), pullRequestNumber: pull.number, url: pull.url, outcome: "excluded", reason: eligibility.reason, matchingPaths: eligibility.matchingPaths, taskId: null, taskStatus: null, previouslyProcessed: false }); continue; }
          const current = this.rule(rule.companyId, rule.id);
          if (!current.enabled || current.revision !== rule.revision || current.authorityUserId !== rule.authorityUserId) throw new AuthFailure("This GitHub rule changed. Refresh and try again.", 409);
          this.sameLocal(rule.authorityUserId, rule.companyId, rule, local);
          const result = await this.tasks!.createTaskFromGithubTrigger(pending.id);
          activity.push({ at: timestamp(), pullRequestNumber: pull.number, url: pull.url, outcome: "eligible", reason: "Backlog task created.", matchingPaths: [], taskId: result.task.id, taskStatus: result.task.status, previouslyProcessed: true });
        } catch (error) { const detail = message(error); failed = true; if (detail.retryAt && (!providerRetryAt || Date.parse(detail.retryAt) > Date.parse(providerRetryAt))) providerRetryAt = detail.retryAt; activity.push({ at: timestamp(), pullRequestNumber: pending.pullRequestNumber, url: null, outcome: "error", reason: detail.text, matchingPaths: [], taskId: null, taskStatus: null, previouslyProcessed: false }); }
      }
      for (const linked of dispatches.listByRule(rule.companyId, rule.id).filter(value => value.taskId)) {
        try { await this.tasks!.startTaskFromGithubTrigger(linked.id, this.github); }
        catch (error) { failed = true; const detail = message(error); activity.push({ at: timestamp(), pullRequestNumber: linked.pullRequestNumber, url: null, outcome: "error", reason: detail.text, matchingPaths: [], taskId: linked.taskId, taskStatus: "backlog", previouslyProcessed: true }); }
      }
      const candidates = await this.github.listOpenPullRequestsByLabel({ repository: rule.repositoryName, label: rule.label });
      for (const candidate of candidates) {
        try {
        const pull = await this.github.inspectPullRequest({ repository: rule.repositoryName, number: candidate.number });
        const eligibility = this.eligible(rule, local, pull);
        const prior = dispatches.find(rule.id, pull.baseRepository.id, pull.number);
        if (eligibility.reason || prior) {
          activity.push({ at: timestamp(), pullRequestNumber: pull.number, url: pull.url, outcome: "excluded", reason: prior ? "This pull request was previously processed." : eligibility.reason!, matchingPaths: eligibility.matchingPaths, taskId: prior?.taskId ?? null, taskStatus: prior?.taskId ? this.tasks!.getTask(rule.authorityUserId, prior.taskId).status : null, previouslyProcessed: Boolean(prior) });
          continue;
        }
        const final = await this.github.inspectPullRequest({ repository: rule.repositoryName, number: pull.number });
        const finalEligibility = this.eligible(rule, local, final);
        if (final.headSha !== pull.headSha || final.baseSha !== pull.baseSha || final.headBranch !== pull.headBranch || final.baseBranch !== pull.baseBranch || finalEligibility.reason) {
          activity.push({ at: timestamp(), pullRequestNumber: pull.number, url: final.url, outcome: "excluded", reason: "The pull request changed before admission.", matchingPaths: [], taskId: null, taskStatus: null, previouslyProcessed: false });
          continue;
        }
        const roles = workflowDefinition(local.preset.engine).advisorRoles;
        const profiles = { root: local.dependencies.profiles[0]!, worker: local.dependencies.profiles[1]!, advisors: Object.fromEntries(roles.map((role, index) => [role, local.dependencies.profiles[index + 2]!])) };
        const prepared = this.database.authImmediateTransaction(db => { const currentRule = this.rule(rule.companyId, rule.id); if (!currentRule.enabled || currentRule.revision !== rule.revision || currentRule.authorityUserId !== rule.authorityUserId) throw new AuthFailure("This GitHub rule changed. Refresh and try again.", 409); this.sameLocal(rule.authorityUserId, rule.companyId, rule, local); assertPullRequestAvailable(db, { taskId: "", repository: rule.repositoryName, number: pull.number }); return dispatches.prepare({ ruleId: rule.id, companyId: rule.companyId, projectId: rule.projectId, repositoryId: rule.repositoryId, repositoryName: rule.repositoryName, pullRequestNumber: pull.number, authorityUserId: rule.authorityUserId, request: { projectId: rule.projectId, title: pull.title, description: "Apply the selected workflow to this pull request.", images: [], rootProfileId: profiles.root.profileId, workerProfileId: profiles.worker.profileId, advisorProfileIds: Object.fromEntries(Object.entries(profiles.advisors).map(([role, profile]) => [role, profile.profileId])), workflow: local.preset.engine, deliveryTarget: rule.deliveryTarget, runProjectTests: local.dependencies.workflow.runProjectTests, visualEvidence: local.dependencies.workflow.visualEvidence, source: { kind: "pull_request", number: pull.number } }, policy: { headSha: pull.headSha, baseSha: pull.baseSha, headBranch: pull.headBranch, baseBranch: pull.baseBranch, protectedPaths: rule.protectedPaths, repositoryId: rule.repositoryId, repositoryName: rule.repositoryName, deliveryTarget: rule.deliveryTarget }, preset: local.preset, profiles }); });
        await this.tasks!.createTaskFromGithubTrigger(prepared.id);
        const started = await this.tasks!.startTaskFromGithubTrigger(prepared.id, this.github);
        activity.push({ at: timestamp(), pullRequestNumber: pull.number, url: pull.url, outcome: "eligible", reason: "Task started.", matchingPaths: [], taskId: started.id, taskStatus: started.status, previouslyProcessed: true });
        } catch (error) { const detail = message(error); failed = true; if (detail.retryAt && (!providerRetryAt || Date.parse(detail.retryAt) > Date.parse(providerRetryAt))) providerRetryAt = detail.retryAt; activity.push({ at: timestamp(), pullRequestNumber: candidate.number, url: null, outcome: "error", reason: detail.text, matchingPaths: [], taskId: null, taskStatus: null, previouslyProcessed: false }); }
      }
      if (failed) {
        const delay = Math.min(15 * 60_000, 60_000 * 2 ** Math.min(rule.failureCount, 4));
        const retryAt = providerRetryAt && Date.parse(providerRetryAt) > Date.now() + delay ? providerRetryAt : new Date(Date.now() + delay).toISOString();
        this.repository.record(rule, rule.revision, activity, false, "GitHub could not complete this check.", retryAt);
      } else if (!this.repository.record(rule, rule.revision, activity, true, null, null, false, () => this.sameLocal(rule.authorityUserId, rule.companyId, rule, local))) throw new AuthFailure("This GitHub rule changed. Refresh and try again.", 409);
    } catch (error) {
      const detail = message(error); const retryAt = detail.retryAt ?? new Date(Date.now() + 60_000).toISOString();
      this.repository.record(rule, rule.revision, activity, false, detail.text, retryAt);
      throw error;
    }
  }
  private eligible(rule: GithubTriggerRule, local: Local, pull: GithubTriggerPullRequestInspection, policy?: { headSha: string; baseSha: string; headBranch: string; baseBranch: string; repositoryId: number; repositoryName: string; protectedPaths: string[] }): { reason: string | null; matchingPaths: string[] } {
    const protectedPaths = policy?.protectedPaths ?? rule.protectedPaths;
    const matchingPaths = pull.files.flatMap(file => [file.filename, file.previousFilename].filter((path): path is string => path !== null && matchesGithubTriggerProtectedPaths(protectedPaths, { filename: path })));
    const repository = policy ?? { repositoryId: rule.repositoryId, repositoryName: rule.repositoryName };
    const same = pull.baseRepository.id === repository.repositoryId && pull.baseRepository.fullName.toLowerCase() === repository.repositoryName.toLowerCase() && pull.headRepository?.id === repository.repositoryId && pull.headRepository.fullName.toLowerCase() === repository.repositoryName.toLowerCase();
    const drift = policy && (pull.headSha !== policy.headSha || pull.baseSha !== policy.baseSha || pull.headBranch !== policy.headBranch || pull.baseBranch !== policy.baseBranch);
    const reason = pull.number < 1 ? "The pull request is invalid." : !same ? "The pull request repository does not match this rule." : pull.state !== "open" ? "The pull request is closed." : pull.isDraft ? "The pull request is a draft." : pull.isCrossRepository ? "The pull request comes from a fork." : pull.baseBranch !== local.baseBranch ? "The pull request targets a different base branch." : !pull.labels.includes(rule.label) ? "The pull request does not have the required label." : matchingPaths.length ? "The pull request changes a protected path." : drift ? "The pull request changed before admission." : this.repository.ownsPullRequest(rule.repositoryName, pull.number) ? "A task already uses this pull request." : null;
    return { reason, matchingPaths };
  }
  private async provider(repository: string, label: string): Promise<{ id: number; fullName: string }> { const binding = await this.github.observeRepository({ repository }); await this.github.validateLabel({ repository: binding.fullName, label }); return binding; }
  private sameLocal(userId: string, companyId: string, config: Config, expected: Local): void { if (!isDeepStrictEqual(this.local(userId, companyId, config).dependencies, expected.dependencies)) throw new AuthFailure("This GitHub rule changed. Refresh and try again.", 409); }
  private write(userId: string, current: GithubTriggerRule, next: GithubTriggerRule, expectedRevision: number, verify: () => void = () => {}): GithubTriggerRule { try { if (!this.repository.update(next, expectedRevision, () => { this.admin(userId, current.companyId); verify(); }, () => this.auth.recordAuditEventInTransaction(undefined, userId, "github_trigger_updated", undefined, current.companyId, { ruleId: current.id }))) throw new AuthFailure("This GitHub rule changed. Refresh and try again.", 409); } catch (error) { if (error instanceof Error && /UNIQUE constraint failed: suplex_github_trigger_rules\.repository_id/i.test(error.message)) throw new AuthFailure("An enabled GitHub rule already exists for this repository", 409); throw error; } return next; }
  private rule(companyId: string, ruleId: string): GithubTriggerRule { const rule = this.repository.get(companyId, ruleId); if (!rule) throw new AuthFailure("Not found", 404); return rule; }
  private admin(userId: string, companyId: string): void { this.auth.requireCompanyAccess(userId, companyId); if (this.auth.getUserForAuthority(userId)?.role !== "admin") throw new AuthFailure("Administrator access required", 403); }
}
