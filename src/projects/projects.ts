import { ProjectIntegrationSchema, type ProjectIntegration } from "./integration-configuration.js";
import { ProjectExecutionSchema, type ProjectExecution } from "./execution-configuration.js";
import { BitbucketClient, createBitbucketReleasePort } from "../integrations/bitbucket.js";
import { repositoryCoordinate } from "./repository-coordinate.js";
import { IssueTracker } from "../integrations/issue-tracker.js";
import { randomBytes } from "node:crypto";
import { isProfileAllowed, ProjectProviderPolicySchema, type ProjectProviderPolicy } from "./provider-policy.js";
import { access, constants, lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Database } from "better-sqlite3";
import { z } from "zod";

import type { AuthUser } from "../identity/auth.js";
import { AuthFailure, type AuthService } from "../identity/auth.js";
import type { SuplexConfig } from "../platform/config.js";
import { GithubFailure, createGithubAdapter, type GithubAdapter } from "../integrations/github/client.js";
import type { SuplexDatabase } from "../platform/database.js";
import { createGithubReleasePort, type GithubReleasePort } from "../integrations/github/delivery.js";
import { TaskSourceService, type TaskSourceSelector } from "../tasks/sources.js";
import { readProviders as readHostProviders, type ReadProviders } from "../profiles/provider-catalog.js";
import { HarnessKindSchema, type HarnessKind } from "../runtimes/harness-kind.js";
import { inferRepositoryCommands } from "./repository-commands.js";
import {
  canonicalDirectory as inspectCanonicalDirectory,
  defaultLocalRepositoryAdapter as createLocalRepositoryAdapter,
  withinRoot as inspectedWithinRoot,
} from "./repository-inspection.js";
import {
  defaultRepositoryProvisioner as createRepositoryProvisioner,
} from "./repository-provisioning.js";
import { ProjectFailure, type ProjectFinding } from "./contracts.js";
import { ProjectAgentTaskPolicySchema, ProjectPatchBodySchema, ProjectProviderInstanceSchema, type ProjectAgentTaskPolicy, type ProjectPatchBody, type ProjectProviderInstance } from "../http/contracts/projects.js";

export { ProjectFailure, type ProjectFinding } from "./contracts.js";

export interface AgentModelOption {
  /** Vendor-qualified for OpenCode rows, such as `openai/gpt-5.6-sol`. */
  id: string;
  provider: HarnessKind;
  providerLabel: string;
  providerStatus: "configured" | "missing";
  displayName: string;
}

export interface ProjectInput {
  integration?: ProjectIntegration | undefined;
  execution?: ProjectExecution | undefined;
  providerPolicy?: ProjectProviderPolicy | null | undefined;
  name: string;
  repositoryPath: string;
  worktreeRoot: string;
  repository: string;
  baseBranch: string;
  setupCommand: string;
  verificationCommand: string;
  rootProfileId: string;
  workerProfileId: string;
  agentTaskPolicy?: ProjectAgentTaskPolicy | undefined;
}

export interface Project {
  integration?: ProjectIntegration;
  execution?: ProjectExecution;
  providerPolicy?: ProjectProviderPolicy | null;
  id: string;
  companyId: string;
  name: string;
  repositoryPath: string;
  worktreeRoot: string;
  repository: string | undefined;
  baseBranch: string;
  setupCommand: string;
  verificationCommand: string;
  rootProfileId: string;
  workerProfileId: string;
  agentTaskPolicy?: ProjectAgentTaskPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface LocalRepositoryInspection {
  canonicalPath: string;
  remoteRepository: string;
  clean: boolean;
  baseSha: string;
}

export interface LocalRepositoryAdapter {
  inspect(input: { repositoryPath: string; baseBranch: string }): Promise<LocalRepositoryInspection>;
}

export interface RepositoryProvisioner {
  ensure(input: { cloneUrl: string; repository: string; repositoryPath: string; worktreeRoot: string }): Promise<void>;
}

interface ProjectServiceOptions {
  readProviders?: ReadProviders;
  github?: GithubAdapter;
  localRepository?: LocalRepositoryAdapter;
  repositoryProvisioner?: RepositoryProvisioner;
  now?: () => Date;
  validateProjectConfiguration?: boolean;
  githubRelease?: Pick<GithubReleasePort, "listOpenPullRequests" | "getPullRequest" | "listOpenIssues" | "getIssue">;
}

interface ProjectRow {
  integration_json: string | null;
  execution_json: string | null;
  provider_policy_json: string | null;
  id: string;
  company_id: string;
  name: string;
  repository_path: string;
  worktree_root: string;
  repository_identity: string | null;
  base_branch: string;
  setup_command: string;
  verification_command: string;
  root_profile_id: string;
  worker_profile_id: string;
  agent_task_policy_json: string;
  created_at: string;
  updated_at: string;
}

const projectColumns = "p.*";

const namePattern = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._'-]{0,78}[\p{L}\p{N}])?$/u;
const repositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;
const branchPattern = /^(?![./])(?!.*(?:\.\.|\.$|\.lock$|\/\/|\s|[~^:?*\[\\]))[A-Za-z0-9._/-]+$/;
const secretPattern = /(?:gh[pousr]_|github_pat_|token\s*=|password\s*=|secret\s*=|BEGIN [A-Z ]+ PRIVATE KEY|sk-[A-Za-z0-9])/i;
const projectProfileSchema = z.object({ provider: HarnessKindSchema, providerInstanceId: z.string().nullable() });

function identifier(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function withinRoot(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function normalizedInput(input: ProjectInput, paths: { repositoryPath: string; worktreeRoot: string }): ProjectInput {
  const normalized: ProjectInput = {
    ...(input.integration ? { integration: ProjectIntegrationSchema.parse(input.integration) } : {}),
    ...(input.execution ? { execution: ProjectExecutionSchema.parse(input.execution) } : {}),
    name: input.name.trim(),
    repositoryPath: paths.repositoryPath,
    worktreeRoot: paths.worktreeRoot,
    repository: input.repository.trim().toLowerCase(),
    baseBranch: input.baseBranch.trim(),
    setupCommand: input.setupCommand.trim(),
    verificationCommand: input.verificationCommand.trim(),
    rootProfileId: input.rootProfileId.trim(),
    workerProfileId: input.workerProfileId.trim(),
  };
  return normalized;
}

function publicProject(row: ProjectRow): Project {
  const defaultAgentTaskPolicy: ProjectAgentTaskPolicy = {
    workflowIds: ["workflow_native_standard"], defaultWorkflowId: "workflow_native_standard", templateIds: [], rootProfileIds: [row.root_profile_id], workerProfileIds: [row.worker_profile_id],
    advisorProfileIds: { reviewer: [], planner_a: [], planner_b: [], rater: [] }, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off",
  };
  return {
    ...(row.integration_json ? { integration: ProjectIntegrationSchema.parse(JSON.parse(row.integration_json)) } : {}),
    ...(row.execution_json ? { execution: ProjectExecutionSchema.parse(JSON.parse(row.execution_json)) } : {}),
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    repositoryPath: row.repository_path,
    worktreeRoot: row.worktree_root,
    repository: row.repository_identity ?? undefined,
    baseBranch: row.base_branch,
    setupCommand: row.setup_command,
    verificationCommand: row.verification_command,
    rootProfileId: row.root_profile_id,
    workerProfileId: row.worker_profile_id,
    agentTaskPolicy: readAgentTaskPolicy(row.agent_task_policy_json, defaultAgentTaskPolicy),
    providerPolicy: row.provider_policy_json ? ProjectProviderPolicySchema.parse(JSON.parse(row.provider_policy_json)) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readAgentTaskPolicy(raw: string, legacyDefault: ProjectAgentTaskPolicy): ProjectAgentTaskPolicy {
  if (raw === "{}") return legacyDefault;
  try { return ProjectAgentTaskPolicySchema.parse(JSON.parse(raw)); }
  catch { throw new ProjectFailure("Project agent policy is invalid", [finding("agent-task-policy-invalid", "agentTaskPolicy", "Project agent task policy must be repaired before it can be used")], 422); }
}

const withProfile = (ids: string[], profileId: string): string[] => ids.includes(profileId) ? ids : [...ids, profileId];

function finding(code: string, field: string, message: string): ProjectFinding {
  return { code, field, message };
}

function isUsableCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed.length > 0 && trimmed.length <= 500 && !/[\r\n]/.test(command) && !secretPattern.test(command);
}

export { inferRepositoryCommands } from "./repository-commands.js";

export class ProjectService {
  private readonly now: () => Date;
  private readonly github: GithubAdapter;
  private readonly localRepository: LocalRepositoryAdapter | undefined;
  private readonly repositoryProvisioner: RepositoryProvisioner;
  private readonly validateProjectConfiguration: boolean;
  private readonly taskSources: TaskSourceService;
  private readonly readProviders: ReadProviders;

  constructor(
    private readonly database: SuplexDatabase,
    private readonly auth: AuthService,
    private readonly config: SuplexConfig,
    options: ProjectServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.github = options.github ?? createGithubAdapter();
    this.localRepository = options.localRepository;
    this.repositoryProvisioner = options.repositoryProvisioner ?? createRepositoryProvisioner();
    // Unit fixtures do not represent a local checkout or a provider session.
    // They opt out without performing network work; production keeps the
    // save-time guard unless an explicit test fake supplies a value.
    this.validateProjectConfiguration = options.validateProjectConfiguration ?? process.env.VITEST === undefined;
    this.taskSources = new TaskSourceService(options.githubRelease ?? createGithubReleasePort());
    this.readProviders = options.readProviders ?? (() => readHostProviders({ directory: process.cwd() }));
  }

  async listModels(actorUserId: string): Promise<AgentModelOption[]> {
    this.user(actorUserId);
    const native = await this.readProviders();
    return native.providers.flatMap((provider) => provider.models.map((model) => ({ id: model.id, provider: provider.id, providerLabel: provider.label, providerStatus: provider.status, displayName: model.label })));
  }

  async getProjectRepositoryDefaults(actorUserId: string, projectId: string): Promise<{ setupCommand: string; verificationCommand: string }> {
    const project = this.getProject(actorUserId, projectId);
    return inferRepositoryCommands(project.repositoryPath);
  }

  listProjectProviderInstances(actorUserId: string, projectId: string): ProjectProviderInstance[] {
    this.getProject(actorUserId, projectId);
    return this.database.authQuery((db) => z.array(ProjectProviderInstanceSchema).parse(db.prepare("SELECT id, provider, label FROM suplex_provider_instances ORDER BY provider, label COLLATE NOCASE, id").all()));
  }

  createProject(actorUserId: string, companyId: string, input: ProjectInput): Promise<Project> {
    return this.mutateProject(actorUserId, companyId, input, false);
  }

  async createProjectFromRepository(actorUserId: string, companyId: string, repositoryUrl: string, options: { integration?: ProjectIntegration | undefined; baseBranch?: string | undefined } = {}): Promise<Project> {
    const company = this.auth.requireCompanyAccess(actorUserId, companyId);
    if (company.status !== "active") throw new ProjectFailure("Company is not active", [finding("company-inactive", "companyId", "Project configuration requires an active company")], 409);
    const coordinate = repositoryCoordinate(repositoryUrl);
    if (!coordinate) throw new ProjectFailure("Repository URL is invalid", [], 422);
    if (coordinate.host !== (options.integration?.repository.kind ?? "github")) throw new ProjectFailure("Select the repository host and its credentials", [], 422);
    const [owner, repositoryName] = coordinate.repository.split("/");
    if (!owner || !repositoryName) throw new ProjectFailure("GitHub repository URL is invalid", [finding("repository-url", "repositoryUrl", "Use an HTTPS or SSH URL for one GitHub repository")], 422);
    const repositoryPath = resolve(this.config.repositoryRoot, owner, repositoryName);
    const worktreeRoot = resolve(this.config.worktreeRoot, owner, repositoryName);
    if (!inspectedWithinRoot(repositoryPath, resolve(this.config.repositoryRoot)) || !inspectedWithinRoot(worktreeRoot, resolve(this.config.worktreeRoot))) {
      throw new ProjectFailure("Repository provisioning failed", [finding("path-outside-root", "repositoryUrl", "Derived project paths escaped the configured Suplex roots")], 422);
    }
    await this.repositoryProvisioner.ensure({ cloneUrl: coordinate.cloneUrl, repository: coordinate.repository, repositoryPath, worktreeRoot });
    const commands = await inferRepositoryCommands(repositoryPath);
    const draft = await this.mutateProject(actorUserId, companyId, {
      name: coordinate.name,
      repositoryPath,
      worktreeRoot,
      repository: coordinate.repository,
      baseBranch: options.baseBranch ?? "main",
      ...(options.integration ? { integration: options.integration } : {}),
      setupCommand: commands.setupCommand,
      verificationCommand: commands.verificationCommand,
      rootProfileId: "profile_native_root",
      workerProfileId: "profile_native_worker",
    }, false);
    return draft;
  }

  async updateProject(actorUserId: string, projectId: string, input: ProjectInput): Promise<Project> {
    const existing = this.getProject(actorUserId, projectId);
    return this.mutateProject(actorUserId, existing.companyId, input, true, projectId);
  }

  async patchProject(actorUserId: string, projectId: string, rawInput: ProjectPatchBody): Promise<Project> {
    const input = ProjectPatchBodySchema.parse(rawInput);
    const existing = this.getProject(actorUserId, projectId);
    const company = this.auth.requireCompanyAccess(actorUserId, existing.companyId);
    if (company.status !== "active") throw new ProjectFailure("Company is not active", [finding("company-inactive", "companyId", "Project configuration requires an active company")], 409);

    const mergedExecution = input.execution ? ProjectExecutionSchema.parse({ ...existing.execution, ...input.execution }) : existing.execution;
    const candidate: Project = {
      ...existing,
      name: input.name ?? existing.name,
      repositoryPath: input.repositoryPath ?? existing.repositoryPath,
      worktreeRoot: input.worktreeRoot ?? existing.worktreeRoot,
      repository: input.repository ?? existing.repository,
      baseBranch: input.baseBranch ?? existing.baseBranch,
      setupCommand: input.setupCommand ?? existing.setupCommand,
      verificationCommand: input.verificationCommand ?? existing.verificationCommand,
      rootProfileId: input.rootProfileId ?? existing.rootProfileId,
      workerProfileId: input.workerProfileId ?? existing.workerProfileId,
      ...(input.integration !== undefined ? { integration: input.integration } : {}),
      ...(mergedExecution !== undefined ? { execution: mergedExecution } : {}),
      ...(input.providerPolicy !== undefined ? { providerPolicy: input.providerPolicy } : {}),
      ...(input.agentTaskPolicy !== undefined ? { agentTaskPolicy: input.agentTaskPolicy } : {}),
    };
    const findings: ProjectFinding[] = [];
    if (input.name !== undefined && !namePattern.test(input.name.trim())) findings.push(finding("invalid-name", "name", "Project name is invalid"));
    if (input.setupCommand !== undefined && !isUsableCommand(input.setupCommand)) findings.push(finding("unapproved-command", "setupCommand", "Command must be a single non-empty line without secrets"));
    if (input.verificationCommand !== undefined && !isUsableCommand(input.verificationCommand)) findings.push(finding("unapproved-command", "verificationCommand", "Command must be a single non-empty line without secrets"));

    const repositoryConnectionChanged = input.integration !== undefined && JSON.stringify(input.integration.repository) !== JSON.stringify(existing.integration?.repository ?? { kind: "github" });
    const repositoryChanged = input.repositoryPath !== undefined && input.repositoryPath !== existing.repositoryPath
      || input.worktreeRoot !== undefined && input.worktreeRoot !== existing.worktreeRoot
      || input.repository !== undefined && input.repository.trim().toLowerCase() !== existing.repository
      || input.baseBranch !== undefined && input.baseBranch.trim() !== existing.baseBranch
      || repositoryConnectionChanged;
    const remoteRepositoryChanged = input.repositoryPath !== undefined && input.repositoryPath !== existing.repositoryPath
      || input.repository !== undefined && input.repository.trim().toLowerCase() !== existing.repository
      || repositoryConnectionChanged;
    let repositoryPath = candidate.repositoryPath;
    let worktreeRoot = candidate.worktreeRoot;
    if (repositoryChanged) {
      const inspected = await this.validatePatchedRepository(candidate, "worktreeRoot" in input, remoteRepositoryChanged);
      repositoryPath = inspected.repositoryPath;
      worktreeRoot = inspected.worktreeRoot;
      findings.push(...inspected.findings);
    }
    if (findings.length) throw new ProjectFailure("Project configuration is invalid", findings, 422);

    const now = this.now().toISOString();
    try {
      this.database.authTransaction((db) => {
        const currentCompany = this.auth.requireCompanyAccess(actorUserId, existing.companyId);
        if (currentCompany.status !== "active") throw new ProjectFailure("Company is not active", [], 409);
        const stored = this.rowForProject(db, projectId);
        if (!stored || stored.company_id !== existing.companyId) throw new ProjectFailure("Not found", [], 404);

        if (input.name !== undefined) db.prepare("UPDATE suplex_projects SET name = ? WHERE id = ?").run(input.name.trim(), projectId);
        if (input.repositoryPath !== undefined) db.prepare("UPDATE suplex_projects SET repository_path = ? WHERE id = ?").run(repositoryPath, projectId);
        if (input.worktreeRoot !== undefined) db.prepare("UPDATE suplex_projects SET worktree_root = ? WHERE id = ?").run(worktreeRoot, projectId);
        if (input.repository !== undefined) db.prepare("UPDATE suplex_projects SET repository_identity = ? WHERE id = ?").run(input.repository.trim().toLowerCase(), projectId);
        if (input.baseBranch !== undefined) db.prepare("UPDATE suplex_projects SET base_branch = ? WHERE id = ?").run(input.baseBranch.trim(), projectId);
        if (input.setupCommand !== undefined) db.prepare("UPDATE suplex_projects SET setup_command = ? WHERE id = ?").run(input.setupCommand.trim(), projectId);
        if (input.verificationCommand !== undefined) db.prepare("UPDATE suplex_projects SET verification_command = ? WHERE id = ?").run(input.verificationCommand.trim(), projectId);
        if (input.integration !== undefined) db.prepare("UPDATE suplex_projects SET integration_json = ? WHERE id = ?").run(JSON.stringify(ProjectIntegrationSchema.parse(input.integration)), projectId);
        if (input.execution) {
          const storedExecution = stored.execution_json ? ProjectExecutionSchema.parse(JSON.parse(stored.execution_json)) : ProjectExecutionSchema.parse({});
          const execution = ProjectExecutionSchema.parse({ ...storedExecution, ...input.execution });
          db.prepare("UPDATE suplex_projects SET execution_json = ? WHERE id = ?").run(JSON.stringify(execution), projectId);
        }

        const agentChanged = input.rootProfileId !== undefined || input.workerProfileId !== undefined || input.agentTaskPolicy !== undefined || input.providerPolicy !== undefined;
        if (agentChanged) this.patchAgentConfiguration(db, stored, projectId, input);
        db.prepare("UPDATE suplex_projects SET updated_at = ? WHERE id = ?").run(now, projectId);
        this.auth.recordAuditEventInTransaction(db, actorUserId, "project_updated", undefined, existing.companyId, { projectId });
      });
    } catch (error) {
      if (error instanceof Error && (error.message.includes("suplex_projects.") || error.message.includes("suplex_projects_repository_identity_unique"))) {
        const field = error.message.includes("repository_path") ? "repositoryPath" : error.message.includes("worktree_root") ? "worktreeRoot" : error.message.includes("repository_identity") ? "repository" : error.message.includes("company_id") && error.message.includes("name") ? "name" : undefined;
        if (!field) throw error;
        throw new ProjectFailure("Project configuration is invalid", [finding("already-assigned", field, "This coordinate is already assigned to another project")], 409);
      }
      throw error;
    }
    return this.getProject(actorUserId, projectId);
  }

  /** Resolve the runtime values that a newly-created task owns thereafter. */
  async captureTaskConfiguration(project: Project): Promise<{ baseSha: string }> {
    try {
      const inspection = await (this.localRepository ?? await createLocalRepositoryAdapter(project.integration?.repository.kind)).inspect({ repositoryPath: project.repositoryPath, baseBranch: project.baseBranch });
      if (!inspection.baseSha) throw new Error("branch unavailable");
      return { baseSha: inspection.baseSha };
    } catch {
      throw new ProjectFailure("Project configuration could not be captured", [finding("repository-unavailable", "projectId", "Suplex could not resolve the configured branches for this new task")], 422);
    }
  }

  async discoverTaskSources(actorUserId: string, projectId: string, kind: TaskSourceSelector["kind"]): Promise<Awaited<ReturnType<TaskSourceService["discover"]>>> {
    const project = this.getProject(actorUserId, projectId);
    if (kind === "issue" && project.integration && (project.integration.tracker?.kind !== "github" || project.integration.tracker.repository.toLowerCase() !== project.repository?.toLowerCase())) return { available: false, reason: "The source issue does not match the configured tracker.", sources: [] };
    const sources = project.integration?.repository.kind === "bitbucket" ? new TaskSourceService(createBitbucketReleasePort(project.integration.repository)) : this.taskSources;
    return sources.discover(project, kind);
  }

  async resolveTaskSource(project: Project, selector: TaskSourceSelector): Promise<Awaited<ReturnType<TaskSourceService["resolve"]>>> {
    if (selector.kind === "issue" && project.integration && (project.integration.tracker?.kind !== "github" || project.integration.tracker.repository.toLowerCase() !== project.repository?.toLowerCase())) throw new ProjectFailure("The source issue does not match the configured tracker.", [], 422);
    const sources = project.integration?.repository.kind === "bitbucket" ? new TaskSourceService(createBitbucketReleasePort(project.integration.repository)) : this.taskSources;
    return sources.resolve(project, selector);
  }

  async searchIssues(actorUserId: string, projectId: string, query: string) {
    const project = this.getProject(actorUserId, projectId);
    const tracker = project.integration ? project.integration.tracker : project.repository ? { kind: "github" as const, repository: project.repository } : null;
    return tracker ? new IssueTracker(tracker).search(query) : [];
  }

  getProject(actorUserId: string, projectId: string): Project {
    const row = this.database.authQuery((db) => {
      const user = this.user(actorUserId);
      const result = user.role === "admin"
        ? db.prepare(`SELECT ${projectColumns} FROM suplex_projects p WHERE p.id = ?`).get(projectId)
        : db.prepare(`SELECT ${projectColumns} FROM suplex_projects p JOIN suplex_memberships m ON m.company_id = p.company_id WHERE p.id = ? AND m.user_id = ?`).get(projectId, actorUserId);
      return result as ProjectRow | undefined;
    });
    if (!row) throw new ProjectFailure("Not found", [], 404);
    return publicProject(row);
  }

  getProjectInCompany(companyId: string, projectId: string): Project {
    const row = this.database.authQuery(db => db.prepare(`SELECT ${projectColumns} FROM suplex_projects p WHERE p.id = ? AND p.company_id = ?`).get(projectId, companyId) as ProjectRow | undefined);
    if (!row) throw new ProjectFailure("Not found", [], 404);
    return publicProject(row);
  }
  async getProjectFavicon(actorUserId: string, projectId: string): Promise<Buffer> {
    const project = this.getProject(actorUserId, projectId);
    const repositoryPath = await realpath(project.repositoryPath).catch(() => undefined);
    if (!repositoryPath) throw new ProjectFailure("Not found", [], 404);
    for (const relativePath of ["favicon.ico", "public/favicon.ico", "static/favicon.ico", "static/images/favicon.ico", "assets/favicon.ico"]) {
      const faviconPath = join(repositoryPath, relativePath);
      try {
        const [iconPath, entry] = await Promise.all([realpath(faviconPath), lstat(faviconPath)]);
        const metadata = await stat(iconPath);
        if (entry.isSymbolicLink() || !withinRoot(iconPath, repositoryPath) || !metadata.isFile() || metadata.size > 1_048_576) continue;
        return await readFile(iconPath);
      } catch {
        // Continue through the approved repository icon locations.
      }
    }
    throw new ProjectFailure("Not found", [], 404);
  }
  listProjects(actorUserId: string, companyId?: string): Project[] {
    const rows = this.database.authQuery((db) => {
      const user = this.user(actorUserId);
      if (companyId) this.auth.requireCompanyAccess(actorUserId, companyId);
      const query = user.role === "admin"
        ? companyId ? db.prepare(`SELECT ${projectColumns} FROM suplex_projects p WHERE p.company_id = ? ORDER BY p.name`) : db.prepare(`SELECT ${projectColumns} FROM suplex_projects p ORDER BY p.name`)
        : companyId ? db.prepare(`SELECT ${projectColumns} FROM suplex_projects p JOIN suplex_memberships m ON m.company_id = p.company_id WHERE m.user_id = ? AND p.company_id = ? ORDER BY p.name`) : db.prepare(`SELECT ${projectColumns} FROM suplex_projects p JOIN suplex_memberships m ON m.company_id = p.company_id WHERE m.user_id = ? ORDER BY p.name`);
      const result = companyId ? user.role === "admin" ? query.all(companyId) : query.all(actorUserId, companyId) : user.role === "admin" ? query.all() : query.all(actorUserId);
      return result as ProjectRow[];
    });
    return rows.map(publicProject);
  }

  private async mutateProject(actorUserId: string, companyId: string, input: ProjectInput, updating: boolean, projectId?: string): Promise<Project> {
    const company = this.auth.requireCompanyAccess(actorUserId, companyId);
    if (company.status !== "active") throw new ProjectFailure("Company is not active", [finding("company-inactive", "companyId", "Project configuration requires an active company")], 409);
    const [repository, worktree] = await Promise.all([
      inspectCanonicalDirectory(input.repositoryPath, this.config.repositoryRoot, "repositoryPath"),
      inspectCanonicalDirectory(input.worktreeRoot, this.config.worktreeRoot, "worktreeRoot"),
    ]);
    const findings = [...repository.findings, ...worktree.findings];
    if (repository.path && worktree.path && (withinRoot(repository.path, worktree.path) || withinRoot(worktree.path, repository.path))) findings.push(finding("worktree-separation", "worktreeRoot", "Worktree root must be separate from the repository"));
    if (!namePattern.test(input.name.trim())) findings.push(finding("invalid-name", "name", "Project name is invalid"));
    if (!repositoryPattern.test(input.repository.trim().toLowerCase())) findings.push(finding("repository-identity", "repository", "Repository must use owner/name identity without credentials"));
    if (!branchPattern.test(input.baseBranch.trim())) findings.push(finding("unsafe-branch", "baseBranch", "Base branch is unsafe"));
    if (!isUsableCommand(input.setupCommand)) findings.push(finding("unapproved-command", "setupCommand", "Command must be a single non-empty line without secrets"));
    if (!isUsableCommand(input.verificationCommand)) findings.push(finding("unapproved-command", "verificationCommand", "Command must be a single non-empty line without secrets"));
    if (secretPattern.test(input.repository) || secretPattern.test(input.baseBranch)) findings.push(finding("secret-shaped-value", "configuration", "Secret-shaped configuration values are not accepted"));
    if (worktree.path) {
      try { await access(worktree.path, constants.W_OK); } catch { findings.push(finding("worktree-unwritable", "worktreeRoot", "Worktree root must be writable")); }
    }
    const previous = updating && projectId ? this.getProject(actorUserId, projectId) : undefined;
    const normalized = normalizedInput({ ...input, integration: input.integration ?? previous?.integration }, { repositoryPath: repository.path ?? resolve(input.repositoryPath), worktreeRoot: worktree.path ?? resolve(input.worktreeRoot) });
    if (this.validateProjectConfiguration && findings.length === 0) {
      try {
        const inspection = await (this.localRepository ?? await createLocalRepositoryAdapter(normalized.integration?.repository.kind)).inspect({ repositoryPath: normalized.repositoryPath, baseBranch: normalized.baseBranch });
        if (inspection.canonicalPath !== normalized.repositoryPath) findings.push(finding("repository-path-mismatch", "repositoryPath", "Repository path is not canonical"));
        if (!inspection.baseSha) findings.push(finding("branch-unavailable", "baseBranch", "Configured branches must resolve to commits"));
        if (inspection.remoteRepository !== normalized.repository) findings.push(finding("repository-mismatch", "repository", "Local origin does not match configured repository identity"));
      } catch (reason) {
        if (reason instanceof ProjectFailure) findings.push(...(reason as ProjectFailure).findings);
        else findings.push(finding("repository-unavailable", "repositoryPath", "Git could not inspect the configured repository"));
      }
    }
    if (this.validateProjectConfiguration && findings.length === 0) {
      try {
        const connection = normalized.integration?.repository;
        if (connection?.kind !== "bitbucket") await this.github.checkAuthentication();
        const remote = connection?.kind === "bitbucket"
          ? await new BitbucketClient(connection).repository(normalized.repository)
          : await this.github.getRepository({ cwd: normalized.repositoryPath, nameWithOwner: normalized.repository });
        const expectedHost = connection?.kind === "bitbucket" ? "bitbucket.org" : "github.com";
        if (remote.nameWithOwner.toLowerCase() !== normalized.repository.toLowerCase()) findings.push(finding("provider-mismatch", "repository", "GitHub repository identity does not match configuration"));
        let providerUrl: URL | undefined;
        try { providerUrl = new URL(remote.url); } catch {}
        if (!providerUrl || providerUrl.protocol !== "https:" || providerUrl.hostname.toLowerCase() !== expectedHost) findings.push(finding("provider-host", "repository", "GitHub provider returned a URL outside github.com"));
        else if (providerUrl.username || providerUrl.password || providerUrl.search || providerUrl.hash || providerUrl.pathname.replace(/\/$/, "").replace(/\.git$/, "").slice(1).toLowerCase() !== normalized.repository) findings.push(finding("provider-path", "repository", "GitHub provider URL does not match configured repository identity"));
      } catch (reason) {
        findings.push(finding(reason instanceof GithubFailure && (reason as GithubFailure).code === "authentication" ? "github-auth-unavailable" : "github-repository-unavailable", "repository", "GitHub repository identity could not be verified"));
      }
    }
    if (findings.length) throw new ProjectFailure("Project configuration is invalid", findings, 422);
    const now = this.now().toISOString();
    let row: { id: string };
    try {
      row = this.database.authTransaction((db) => {
      const currentCompany = this.auth.requireCompanyAccess(actorUserId, companyId);
      if (currentCompany.status !== "active") throw new ProjectFailure("Company is not active", [], 409);
      for (const [role, profileId] of [["root", normalized.rootProfileId], ["worker", normalized.workerProfileId]] as const) {
        if (!db.prepare("SELECT 1 FROM suplex_profiles WHERE id = ? AND role = ? AND archived_at IS NULL").get(profileId, role)) {
          throw new ProjectFailure("Project configuration is invalid", [finding("profile-ineligible", `${role}ProfileId`, "Select an active profile with the matching role")], 422);
        }
      }
      const id = projectId ?? identifier("project");
      const defaultPolicy: ProjectAgentTaskPolicy = {
        workflowIds: ["workflow_native_standard"], defaultWorkflowId: "workflow_native_standard", templateIds: [], rootProfileIds: [normalized.rootProfileId], workerProfileIds: [normalized.workerProfileId], advisorProfileIds: { reviewer: [], planner_a: [], planner_b: [], rater: [] },
        deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off",
      };
      const stored = updating ? this.rowForProject(db, id)! : undefined;
      const providerPolicy = input.providerPolicy === undefined ? stored?.provider_policy_json ?? null : input.providerPolicy === null ? null : JSON.stringify(ProjectProviderPolicySchema.parse(input.providerPolicy));
      if (providerPolicy) {
        for (const instanceId of ProjectProviderPolicySchema.parse(JSON.parse(providerPolicy)).allowedInstanceIds) {
          if (!db.prepare("SELECT 1 FROM suplex_provider_instances WHERE id = ?").get(instanceId)) throw new ProjectFailure("Project configuration is invalid", [finding("instance-ineligible", "providerPolicy", "Select an existing provider login")], 422);
        }
      }
      const storedPolicy = stored ? readAgentTaskPolicy(stored.agent_task_policy_json, defaultPolicy) : undefined;
      // Without an explicit policy body the stored allowlists still have to admit the project's own defaults, or agent creates without profile ids would be refused.
      const policy = ProjectAgentTaskPolicySchema.parse(input.agentTaskPolicy ?? (storedPolicy ? { ...storedPolicy, rootProfileIds: withProfile(storedPolicy.rootProfileIds, normalized.rootProfileId), workerProfileIds: withProfile(storedPolicy.workerProfileIds, normalized.workerProfileId) } : defaultPolicy));
      if (input.agentTaskPolicy) this.validateAgentTaskPolicy(db, policy, id);
      if (updating) {
        const existing = this.rowForProject(db, id);
        if (!existing || existing.company_id !== companyId) throw new ProjectFailure("Not found", [], 404);
        db.prepare("UPDATE suplex_projects SET name = ?, repository_path = ?, worktree_root = ?, repository_identity = ?, base_branch = ?, setup_command = ?, verification_command = ?, root_profile_id = ?, worker_profile_id = ?, agent_task_policy_json = ?, updated_at = ? WHERE id = ?").run(normalized.name, normalized.repositoryPath, normalized.worktreeRoot, normalized.repository, normalized.baseBranch, normalized.setupCommand, normalized.verificationCommand, normalized.rootProfileId, normalized.workerProfileId, JSON.stringify(policy), now, id);
      } else {
        db.prepare("INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, companyId, normalized.name, normalized.repositoryPath, normalized.worktreeRoot, normalized.repository, normalized.baseBranch, normalized.setupCommand, normalized.verificationCommand, normalized.rootProfileId, normalized.workerProfileId, JSON.stringify(policy), now, now);
      }
      db.prepare("UPDATE suplex_projects SET integration_json = ?, execution_json = ? WHERE id = ?").run(input.integration === undefined ? stored?.integration_json ?? null : JSON.stringify(normalized.integration), input.execution === undefined ? stored?.execution_json ?? null : JSON.stringify(normalized.execution), id);
      this.auth.recordAuditEventInTransaction(db, actorUserId, updating ? "project_updated" : "project_created", undefined, companyId, { projectId: id });
      db.prepare("UPDATE suplex_projects SET provider_policy_json = ? WHERE id = ?").run(providerPolicy, id);
      return { id };
      });
    } catch (error) {
      if (error instanceof Error && (error.message.includes("suplex_projects.") || error.message.includes("suplex_projects_repository_identity_unique"))) {
        const field = error.message.includes("repository_path") ? "repositoryPath" : error.message.includes("worktree_root") ? "worktreeRoot" : error.message.includes("repository_identity") ? "repository" : error.message.includes("company_id") && error.message.includes("name") ? "name" : undefined;
        if (!field) throw error;
        throw new ProjectFailure("Project configuration is invalid", [finding("already-assigned", field, "This coordinate is already assigned to another project")], 409);
      }
      throw error;
    }
    return this.getProject(actorUserId, row.id);
  }

  private async validatePatchedRepository(project: Project, validateWorktreeWrite: boolean, validateRemote: boolean): Promise<{ repositoryPath: string; worktreeRoot: string; findings: ProjectFinding[] }> {
    const [repository, worktree] = await Promise.all([
      inspectCanonicalDirectory(project.repositoryPath, this.config.repositoryRoot, "repositoryPath"),
      inspectCanonicalDirectory(project.worktreeRoot, this.config.worktreeRoot, "worktreeRoot"),
    ]);
    const findings = [...repository.findings, ...worktree.findings];
    if (repository.path && worktree.path && (withinRoot(repository.path, worktree.path) || withinRoot(worktree.path, repository.path))) findings.push(finding("worktree-separation", "worktreeRoot", "Worktree root must be separate from the repository"));
    const repositoryIdentity = project.repository?.trim().toLowerCase() ?? "";
    if (!repositoryPattern.test(repositoryIdentity)) findings.push(finding("repository-identity", "repository", "Repository must use owner/name identity without credentials"));
    if (!branchPattern.test(project.baseBranch.trim())) findings.push(finding("unsafe-branch", "baseBranch", "Base branch is unsafe"));
    if (secretPattern.test(repositoryIdentity) || secretPattern.test(project.baseBranch)) findings.push(finding("secret-shaped-value", "configuration", "Secret-shaped configuration values are not accepted"));
    if (validateWorktreeWrite && worktree.path) {
      try { await access(worktree.path, constants.W_OK); } catch { findings.push(finding("worktree-unwritable", "worktreeRoot", "Worktree root must be writable")); }
    }
    const repositoryPath = repository.path ?? resolve(project.repositoryPath);
    const worktreeRoot = worktree.path ?? resolve(project.worktreeRoot);
    if (this.validateProjectConfiguration && findings.length === 0) {
      try {
        const inspection = await (this.localRepository ?? await createLocalRepositoryAdapter(project.integration?.repository.kind)).inspect({ repositoryPath, baseBranch: project.baseBranch.trim() });
        if (inspection.canonicalPath !== repositoryPath) findings.push(finding("repository-path-mismatch", "repositoryPath", "Repository path is not canonical"));
        if (!inspection.baseSha) findings.push(finding("branch-unavailable", "baseBranch", "Configured branches must resolve to commits"));
        if (inspection.remoteRepository !== repositoryIdentity) findings.push(finding("repository-mismatch", "repository", "Local origin does not match configured repository identity"));
      } catch (reason) {
        if (reason instanceof ProjectFailure) findings.push(...reason.findings);
        else findings.push(finding("repository-unavailable", "repositoryPath", "Git could not inspect the configured repository"));
      }
    }
    if (validateRemote && this.validateProjectConfiguration && findings.length === 0) {
      try {
        const connection = project.integration?.repository;
        if (connection?.kind !== "bitbucket") await this.github.checkAuthentication();
        const remote = connection?.kind === "bitbucket"
          ? await new BitbucketClient(connection).repository(repositoryIdentity)
          : await this.github.getRepository({ cwd: repositoryPath, nameWithOwner: repositoryIdentity });
        const expectedHost = connection?.kind === "bitbucket" ? "bitbucket.org" : "github.com";
        if (remote.nameWithOwner.toLowerCase() !== repositoryIdentity) findings.push(finding("provider-mismatch", "repository", "GitHub repository identity does not match configuration"));
        let providerUrl: URL | undefined;
        try { providerUrl = new URL(remote.url); } catch {}
        if (!providerUrl || providerUrl.protocol !== "https:" || providerUrl.hostname.toLowerCase() !== expectedHost) findings.push(finding("provider-host", "repository", "GitHub provider returned a URL outside github.com"));
        else if (providerUrl.username || providerUrl.password || providerUrl.search || providerUrl.hash || providerUrl.pathname.replace(/\/$/, "").replace(/\.git$/, "").slice(1).toLowerCase() !== repositoryIdentity) findings.push(finding("provider-path", "repository", "GitHub provider URL does not match configured repository identity"));
      } catch (reason) {
        findings.push(finding(reason instanceof GithubFailure && reason.code === "authentication" ? "github-auth-unavailable" : "github-repository-unavailable", "repository", "GitHub repository identity could not be verified"));
      }
    }
    return { repositoryPath, worktreeRoot, findings };
  }

  private patchAgentConfiguration(db: Database, stored: ProjectRow, projectId: string, input: ProjectPatchBody): void {
    const rootProfileId = input.rootProfileId?.trim() ?? stored.root_profile_id;
    const workerProfileId = input.workerProfileId?.trim() ?? stored.worker_profile_id;
    const selectedProfiles = [
      ["root", rootProfileId],
      ["worker", workerProfileId],
    ] as const;
    const resolvedProfiles = selectedProfiles.map(([role, profileId]) => {
      const profile = projectProfileSchema.safeParse(db.prepare("SELECT provider, provider_instance_id AS providerInstanceId FROM suplex_profiles WHERE id = ? AND role = ? AND archived_at IS NULL").get(profileId, role));
      if (!profile.success) throw new ProjectFailure("Project configuration is invalid", [finding("profile-ineligible", `${role}ProfileId`, "Select an active profile with the matching role")], 422);
      return { role, profileId, profile: profile.data };
    });
    const providerPolicy = input.providerPolicy !== undefined
      ? input.providerPolicy
      : stored.provider_policy_json ? ProjectProviderPolicySchema.parse(JSON.parse(stored.provider_policy_json)) : null;
    if (providerPolicy) {
      for (const instanceId of providerPolicy.allowedInstanceIds) {
        if (!db.prepare("SELECT 1 FROM suplex_provider_instances WHERE id = ?").get(instanceId)) throw new ProjectFailure("Project configuration is invalid", [finding("instance-ineligible", "providerPolicy", "Select an existing provider login")], 422);
      }
      for (const selected of resolvedProfiles) {
        if (!isProfileAllowed(providerPolicy, selected.profile)) throw new ProjectFailure("Project configuration is invalid", [finding("profile-provider-ineligible", `${selected.role}ProfileId`, "Select an agent with a provider and login allowed by this project")], 422);
      }
    }

    const defaultPolicy: ProjectAgentTaskPolicy = {
      workflowIds: ["workflow_native_standard"], defaultWorkflowId: "workflow_native_standard", templateIds: [], rootProfileIds: [rootProfileId], workerProfileIds: [workerProfileId],
      advisorProfileIds: { reviewer: [], planner_a: [], planner_b: [], rater: [] }, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off",
    };
    const storedPolicy = readAgentTaskPolicy(stored.agent_task_policy_json, defaultPolicy);
    const policy = ProjectAgentTaskPolicySchema.parse(input.agentTaskPolicy ?? {
      ...storedPolicy,
      rootProfileIds: withProfile(storedPolicy.rootProfileIds, rootProfileId),
      workerProfileIds: withProfile(storedPolicy.workerProfileIds, workerProfileId),
    });
    if (input.agentTaskPolicy) this.validateAgentTaskPolicy(db, policy, projectId);
    if (input.rootProfileId !== undefined) db.prepare("UPDATE suplex_projects SET root_profile_id = ? WHERE id = ?").run(rootProfileId, projectId);
    if (input.workerProfileId !== undefined) db.prepare("UPDATE suplex_projects SET worker_profile_id = ? WHERE id = ?").run(workerProfileId, projectId);
    if (input.agentTaskPolicy !== undefined || input.rootProfileId !== undefined || input.workerProfileId !== undefined) db.prepare("UPDATE suplex_projects SET agent_task_policy_json = ? WHERE id = ?").run(JSON.stringify(policy), projectId);
    if (input.providerPolicy !== undefined) db.prepare("UPDATE suplex_projects SET provider_policy_json = ? WHERE id = ?").run(providerPolicy === null ? null : JSON.stringify(ProjectProviderPolicySchema.parse(providerPolicy)), projectId);
  }

  private rowForProject(db: Database, projectId: string): ProjectRow | undefined {
    return db.prepare(`SELECT ${projectColumns} FROM suplex_projects p WHERE p.id = ?`).get(projectId) as ProjectRow | undefined;
  }

  private validateAgentTaskPolicy(db: Database, policy: ProjectAgentTaskPolicy, projectId: string): void {
    for (const workflowId of policy.workflowIds) if (!db.prepare("SELECT 1 FROM suplex_workflows WHERE id = ? AND archived_at IS NULL").get(workflowId)) throw new ProjectFailure("Project configuration is invalid", [finding("workflow-ineligible", "agentTaskPolicy.workflowIds", "Select active workflows")], 422);
    if (!policy.workflowIds.includes(policy.defaultWorkflowId)) throw new ProjectFailure("Project configuration is invalid", [finding("workflow-default-ineligible", "agentTaskPolicy.defaultWorkflowId", "Select one allowed workflow as the default")], 422);
    for (const templateId of policy.templateIds) if (!db.prepare("SELECT 1 FROM suplex_task_templates WHERE id = ? AND project_id = ?").get(templateId, projectId)) throw new ProjectFailure("Project configuration is invalid", [finding("template-ineligible", "agentTaskPolicy.templateIds", "Select templates that belong to this project")], 422);
    for (const [role, ids] of [["root", policy.rootProfileIds], ["worker", policy.workerProfileIds]] as const) for (const profileId of ids) if (!db.prepare("SELECT 1 FROM suplex_profiles WHERE id = ? AND role = ? AND archived_at IS NULL").get(profileId, role)) throw new ProjectFailure("Project configuration is invalid", [finding("profile-ineligible", "agentTaskPolicy", "Select active profiles with matching roles")], 422);
    for (const ids of Object.values(policy.advisorProfileIds)) for (const profileId of ids) if (!db.prepare("SELECT 1 FROM suplex_profiles WHERE id = ? AND role = 'root' AND archived_at IS NULL").get(profileId)) throw new ProjectFailure("Project configuration is invalid", [finding("profile-ineligible", "agentTaskPolicy", "Select active Advisor profiles")], 422);
  }

  private user(userId: string): AuthUser {
    const user = this.auth.getUserForAuthority(userId);
    if (!user) throw new AuthFailure("Authentication required", 401);
    return user;
  }

}
