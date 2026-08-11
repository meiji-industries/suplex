import { createHash, randomBytes } from "node:crypto";
import { access, constants, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AuthUser } from "./auth.js";
import { AuthFailure, AuthService } from "./auth.js";
import type { ForgeConfig } from "./config.js";
import { GithubFailure, createGithubAdapter, type GithubAdapter } from "./github.js";
import { ForgeDatabase } from "./database.js";

const execFileAsync = promisify(execFile);

export type ProjectStatus = "draft" | "active" | "paused" | "archived";
export type ProjectRole = "lead" | "developer" | "reviewer";
export type ReasoningLevel = "low" | "medium" | "high";
export type ServicePriority = "standard" | "priority";

export interface ProjectFinding {
  code: string;
  field: string;
  message: string;
}

export class ProjectFailure extends Error {
  readonly statusCode: number;
  readonly publicMessage: string;
  readonly findings: ProjectFinding[];

  constructor(publicMessage: string, findings: ProjectFinding[] = [], statusCode = 400) {
    super(publicMessage);
    this.name = "ProjectFailure";
    this.publicMessage = publicMessage;
    this.findings = findings;
    this.statusCode = statusCode;
  }
}

export interface CodexProfile {
  id: string;
  name: string;
  provider: "codex";
  model: string;
  reasoningLevel: ReasoningLevel;
  servicePriority: ServicePriority;
  capacity: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  name: string;
  repositoryPath: string;
  worktreeRoot: string;
  repository: string;
  baseBranch: string;
  targetBranch: string;
  setupCommand: string;
  verificationCommand: string;
  requiredChecks: string[];
  allowedProfileIds: string[];
  roleDefaults: Partial<Record<ProjectRole, string>>;
  baseSha?: string | undefined;
  targetSha?: string | undefined;
}

export interface Project {
  id: string;
  companyId: string;
  name: string;
  repositoryPath: string;
  worktreeRoot: string;
  repository: string | undefined;
  baseBranch: string;
  targetBranch: string;
  setupCommand: string;
  verificationCommand: string;
  requiredChecks: string[];
  allowedProfileIds: string[];
  roleDefaults: Partial<Record<ProjectRole, string>>;
  status: ProjectStatus;
  activeRevisionId?: string;
  configurationRevision: number;
  configurationIdentity?: string;
  baseSha?: string | undefined;
  targetSha?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface LocalRepositoryInspection {
  canonicalPath: string;
  remoteRepository: string;
  clean: boolean;
  baseSha: string;
  targetSha: string;
}

export interface LocalRepositoryAdapter {
  inspect(input: { repositoryPath: string; baseBranch: string; targetBranch: string }): Promise<LocalRepositoryInspection>;
}

interface ProjectServiceOptions {
  github?: GithubAdapter;
  localRepository?: LocalRepositoryAdapter;
  now?: () => Date;
}

interface ProjectRow {
  id: string;
  company_id: string;
  name: string;
  repository_path: string;
  worktree_root: string;
  repository_identity: string | null;
  base_branch: string;
  target_branch: string;
  setup_command: string;
  verification_command: string;
  required_checks_json: string;
  allowed_profiles_json: string;
  role_defaults_json: string;
  status: ProjectStatus;
  active_revision_id: string | null;
  created_at: string;
  updated_at: string;
  configuration_revision?: number;
  configuration_identity?: string;
  base_sha?: string | null;
  target_sha?: string | null;
}

interface ProfileRow {
  id: string;
  name: string;
  provider: "codex";
  model: string;
  reasoning_level: ReasoningLevel;
  service_priority: ServicePriority;
  capacity: number;
  created_at: string;
  updated_at: string;
}

const namePattern = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,78}[\p{L}\p{N}]$/u;
const repositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;
const branchPattern = /^(?![./])(?!.*(?:\.\.|\.$|\.lock$|\/\/|\s|[~^:?*\[\\]))[A-Za-z0-9._/-]+$/;
const checkPattern = /^[\p{L}\p{N}][\p{L}\p{N} ._:/()\[\]-]{0,119}$/u;
const secretPattern = /(?:gh[pousr]_|github_pat_|token\s*=|password\s*=|secret\s*=|BEGIN [A-Z ]+ PRIVATE KEY|sk-[A-Za-z0-9])/i;
const approvedSetupCommands = new Set(["pnpm install", "pnpm install --frozen-lockfile", "npm install", "npm ci", "yarn install", "yarn install --immutable", "bun install"]);
const approvedVerificationCommands = new Set(["pnpm test", "pnpm typecheck", "pnpm lint", "npm test", "npm run typecheck", "npm run lint", "yarn test", "yarn typecheck", "yarn lint", "bun test", "mise run test", "mise run typecheck", "mise run lint", "make test", "make check"]);


function identifier(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function withinRoot(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function asJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizedInput(input: ProjectInput, paths: { repositoryPath: string; worktreeRoot: string }): ProjectInput {
  const normalized: ProjectInput = {
    name: input.name.trim(),
    repositoryPath: paths.repositoryPath,
    worktreeRoot: paths.worktreeRoot,
    repository: input.repository.trim().toLowerCase(),
    baseBranch: input.baseBranch.trim(),
    targetBranch: input.targetBranch.trim(),
    setupCommand: input.setupCommand.trim(),
    verificationCommand: input.verificationCommand.trim(),
    requiredChecks: [...new Set(input.requiredChecks.map((check) => check.trim()).filter(Boolean))].sort(),
    allowedProfileIds: [...new Set(input.allowedProfileIds.map((profileId) => profileId.trim()).filter(Boolean))].sort(),
    roleDefaults: Object.fromEntries(Object.entries(input.roleDefaults).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0).sort(([left], [right]) => left.localeCompare(right))) as Partial<Record<ProjectRole, string>>,
  };
  if (input.baseSha) normalized.baseSha = input.baseSha.trim().toLowerCase();
  if (input.targetSha) normalized.targetSha = input.targetSha.trim().toLowerCase();
  return normalized;
}

function configIdentity(input: ProjectInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function publicProfile(row: ProfileRow): CodexProfile {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    reasoningLevel: row.reasoning_level,
    servicePriority: row.service_priority,
    capacity: row.capacity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicProject(row: ProjectRow): Project {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    repositoryPath: row.repository_path,
    worktreeRoot: row.worktree_root,
    repository: row.repository_identity ?? undefined,
    baseBranch: row.base_branch,
    targetBranch: row.target_branch,
    setupCommand: row.setup_command,
    verificationCommand: row.verification_command,
    requiredChecks: asJson<string[]>(row.required_checks_json, []),
    allowedProfileIds: asJson<string[]>(row.allowed_profiles_json, []),
    roleDefaults: asJson<Partial<Record<ProjectRole, string>>>(row.role_defaults_json, {}),
    status: row.status,
    ...(row.active_revision_id ? { activeRevisionId: row.active_revision_id } : {}),
    configurationRevision: row.configuration_revision ?? 0,
    ...(row.configuration_identity ? { configurationIdentity: row.configuration_identity } : {}),
    ...(row.base_sha ? { baseSha: row.base_sha } : {}),
    ...(row.target_sha ? { targetSha: row.target_sha } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function finding(code: string, field: string, message: string): ProjectFinding {
  return { code, field, message };
}

function isApprovedCommand(command: string, kind: "setup" | "verification"): boolean {
  return (kind === "setup" ? approvedSetupCommands : approvedVerificationCommands).has(command.trim()) && !secretPattern.test(command);
}

function githubRepositoryFromRemote(remoteUrl: string): { identity: string; credentialBearing: boolean } | undefined {
  const trimmed = remoteUrl.trim();
  const normalizedRemote = trimmed.replace(/\.git$/, "");
  const ssh = /^git@github\.com:([A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/.exec(normalizedRemote);
  if (ssh?.[1]) return { identity: ssh[1].toLowerCase(), credentialBearing: false };
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
    const match = /^\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/.exec(parsed.pathname.replace(/\.git$/, ""));
    return match?.[1] ? { identity: match[1].toLowerCase(), credentialBearing: Boolean(parsed.username || parsed.password) } : undefined;
  } catch {
    return undefined;
  }
}

async function canonicalDirectory(raw: string, rootRaw: string, field: string): Promise<{ path?: string; findings: ProjectFinding[] }> {
  const findings: ProjectFinding[] = [];
  const trimmed = raw.trim();
  if (!trimmed || trimmed.split(/[\\/]+/).includes("..")) {
    return { findings: [finding("path-traversal", field, "Path must be an existing canonical directory inside the configured root")] };
  }
  const absolute = resolve(trimmed);
  try {
    const rootAbsolute = resolve(rootRaw);
    const [root, canonical] = await Promise.all([realpath(rootAbsolute), realpath(absolute)]);
    const expectedCanonical = resolve(root, relative(rootAbsolute, absolute));
    if (canonical !== expectedCanonical) {
      findings.push(finding("symlink-ambiguous", field, "Symlinked paths are not accepted"));
    }
    if (!withinRoot(canonical, root)) {
      findings.push(finding("path-outside-root", field, "Path is outside the configured root"));
    }
    await access(canonical, constants.R_OK);
    return findings.length ? { findings } : { path: canonical, findings };
  } catch {
    findings.push(finding("path-unavailable", field, "Path or configured root is unavailable"));
    return { findings };
  }
}

async function defaultLocalRepositoryAdapter(): Promise<LocalRepositoryAdapter> {
  const run = async (args: string[], cwd: string): Promise<string> => {
    try {
      const result = await execFileAsync("git", args, { cwd, timeout: 8_000, maxBuffer: 16 * 1024 });
      return result.stdout.trim();
    } catch {
      throw new ProjectFailure("Repository validation failed", [finding("repository-unavailable", "repositoryPath", "Git could not inspect the configured repository")], 422);
    }
  };
  return {
    async inspect(input) {
      const canonicalPath = await run(["rev-parse", "--show-toplevel"], input.repositoryPath);
      const status = await run(["status", "--porcelain", "--untracked-files=all"], input.repositoryPath);
      const remoteUrl = await run(["remote", "get-url", "origin"], input.repositoryPath);
      if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(remoteUrl) || /(?:token|password|secret)=/i.test(remoteUrl)) {
        throw new ProjectFailure("Repository validation failed", [finding("credential-url", "repository", "Credential-bearing repository URLs are not accepted")], 422);
      }
      const baseSha = await run(["rev-parse", "--verify", `refs/heads/${input.baseBranch}`], input.repositoryPath);
      const targetSha = await run(["rev-parse", "--verify", `refs/heads/${input.targetBranch}`], input.repositoryPath);
      const remote = githubRepositoryFromRemote(remoteUrl);
      if (!remote || remote.credentialBearing) {
        throw new ProjectFailure("Repository validation failed", [finding("repository-identity", "repository", "Origin must identify a canonical GitHub repository")], 422);
      }
      return { canonicalPath, remoteRepository: remote.identity, clean: status.length === 0, baseSha, targetSha };
    },
  };
}

export class ProjectService {
  private readonly now: () => Date;
  private readonly github: GithubAdapter;
  private readonly localRepositoryPromise: Promise<LocalRepositoryAdapter>;

  constructor(
    private readonly database: ForgeDatabase,
    private readonly auth: AuthService,
    private readonly config: ForgeConfig,
    options: ProjectServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.github = options.github ?? createGithubAdapter();
    this.localRepositoryPromise = options.localRepository ? Promise.resolve(options.localRepository) : defaultLocalRepositoryAdapter();
  }

  createProfile(actorUserId: string, input: { name: string; model: string; reasoningLevel: ReasoningLevel; servicePriority: ServicePriority; capacity: number }): CodexProfile {
    const actor = this.requireAdmin(actorUserId);
    void actor;
    const name = input.name.trim();
    const model = input.model.trim();
    if (!namePattern.test(name)) throw new ProjectFailure("Profile configuration is invalid", [finding("invalid-name", "name", "Profile name is invalid")]);
    if (!model || model.length > 120 || /[\r\n]/.test(model) || secretPattern.test(model)) throw new ProjectFailure("Profile configuration is invalid", [finding("invalid-model", "model", "Model name is invalid")]);
    if (!["low", "medium", "high"].includes(input.reasoningLevel)) throw new ProjectFailure("Profile configuration is invalid", [finding("invalid-reasoning", "reasoningLevel", "Reasoning level is invalid")]);
    if (!["standard", "priority"].includes(input.servicePriority)) throw new ProjectFailure("Profile configuration is invalid", [finding("invalid-priority", "servicePriority", "Service priority is invalid")]);
    if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 32) throw new ProjectFailure("Profile configuration is invalid", [finding("invalid-capacity", "capacity", "Capacity must be an integer from 1 to 32")]);
    const now = this.now().toISOString();
    const profile = { id: identifier("profile"), name, provider: "codex" as const, model, reasoningLevel: input.reasoningLevel, servicePriority: input.servicePriority, capacity: input.capacity, createdAt: now, updatedAt: now };
    try {
      this.database.authTransaction((db) => {
        db.prepare(`INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES (?, ?, 'codex', ?, ?, ?, ?, ?, ?)`)
          .run(profile.id, profile.name, profile.model, profile.reasoningLevel, profile.servicePriority, profile.capacity, now, now);
        this.auth.recordAuditEventInTransaction(db, actorUserId, "profile_created", undefined, undefined, { profileId: profile.id });
      });
    } catch {
      throw new ProjectFailure("Profile configuration is invalid", [finding("duplicate-name", "name", "Profile name is already in use")]);
    }
    return profile;
  }

  listProfiles(actorUserId: string): CodexProfile[] {
    this.user(actorUserId);
    return this.database.authQuery((db) => (db.prepare("SELECT * FROM forge_profiles ORDER BY name").all() as ProfileRow[]).map(publicProfile));
  }

  createProject(actorUserId: string, companyId: string, input: ProjectInput): Promise<Project> {
    return this.mutateProject(actorUserId, companyId, input, false);
  }

  async updateProject(actorUserId: string, projectId: string, input: ProjectInput): Promise<Project> {
    const existing = this.getProject(actorUserId, projectId);
    return this.mutateProject(actorUserId, existing.companyId, input, true, projectId);
  }

  async activateProject(actorUserId: string, projectId: string): Promise<Project> {
    const project = this.getProject(actorUserId, projectId);
    const company = this.auth.requireCompanyAccess(actorUserId, project.companyId);
    if (company.status !== "active") throw new ProjectFailure("Project activation failed", [finding("company-inactive", "companyId", "Project activation requires an active company")], 409);
    if (project.status === "archived") throw new ProjectFailure("Project activation failed", [finding("project-archived", "status", "Archived projects cannot be activated")], 409);
    const findings: ProjectFinding[] = [];
    const local = await this.localRepositoryPromise;
    const profiles = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_profiles WHERE id IN (" + project.allowedProfileIds.map(() => "?").join(",") + ")").all(...project.allowedProfileIds) as Array<{ id: string }>);
    const profileIds = new Set(profiles.map((profile) => profile.id));
    for (const profileId of project.allowedProfileIds) if (!profileIds.has(profileId)) findings.push(finding("profile-unavailable", "allowedProfileIds", "Every allowed role profile must exist"));
    for (const [role, profileId] of Object.entries(project.roleDefaults)) if (!project.allowedProfileIds.includes(profileId) || !profileIds.has(profileId)) findings.push(finding("profile-ineligible", `roleDefaults.${role}`, "Role defaults must reference an allowed profile"));
    if (!repositoryPattern.test(project.repository ?? "")) findings.push(finding("repository-identity", "repository", "Repository must use owner/name identity without credentials"));
    if (!branchPattern.test(project.baseBranch)) findings.push(finding("unsafe-branch", "baseBranch", "Base branch is unsafe"));
    if (!branchPattern.test(project.targetBranch)) findings.push(finding("unsafe-branch", "targetBranch", "Target branch is unsafe"));
    if (!isApprovedCommand(project.setupCommand, "setup")) findings.push(finding("unapproved-command", "setupCommand", "Setup must be one approved literal command"));
    if (!isApprovedCommand(project.verificationCommand, "verification")) findings.push(finding("unapproved-command", "verificationCommand", "Verification must be one approved literal command"));
    if (project.requiredChecks.length === 0 || project.requiredChecks.some((check) => !checkPattern.test(check))) findings.push(finding("invalid-check", "requiredChecks", "At least one safe required check is required"));
    let inspection: LocalRepositoryInspection | undefined;
    if (findings.length === 0) {
      try {
        inspection = await local.inspect({ repositoryPath: project.repositoryPath, baseBranch: project.baseBranch, targetBranch: project.targetBranch });
      } catch (error) {
        if (error instanceof ProjectFailure) findings.push(...error.findings);
        else findings.push(finding("repository-unavailable", "repositoryPath", "Git could not inspect the configured repository"));
      }
    }
    if (inspection) {
      if (inspection.canonicalPath !== project.repositoryPath) findings.push(finding("repository-path-mismatch", "repositoryPath", "Repository path is not canonical"));
      if (!inspection.clean) findings.push(finding("repository-dirty", "repositoryPath", "Repository must be clean before activation"));
      if (!inspection.baseSha) findings.push(finding("base-ref-missing", "baseBranch", "Base branch does not resolve to a canonical commit"));
      if (!inspection.targetSha) findings.push(finding("target-ref-missing", "targetBranch", "Target branch does not resolve to a canonical commit"));
      if (inspection.remoteRepository !== project.repository) findings.push(finding("repository-mismatch", "repository", "Local origin does not match configured repository identity"));
    }
    if (findings.length === 0) {
      try {
        await this.github.checkAuthentication();
        const remote = await this.github.getRepository({ cwd: project.repositoryPath, nameWithOwner: project.repository! });
        if (remote.nameWithOwner.toLowerCase() !== project.repository!.toLowerCase()) findings.push(finding("provider-mismatch", "repository", "GitHub repository identity does not match configuration"));
        const remoteUrl = new URL(remote.url);
        if (remoteUrl.hostname.toLowerCase() !== "github.com") findings.push(finding("provider-host", "repository", "Repository URL must be hosted on GitHub"));
        const expectedPath = `/${project.repository!}`;
        if (remoteUrl.pathname.replace(/\.git$/, "").toLowerCase() !== expectedPath.toLowerCase()) findings.push(finding("provider-path", "repository", "Repository URL path does not match configured identity"));
        if (remoteUrl.username || remoteUrl.password) findings.push(finding("credential-url", "repository", "Credential-bearing repository URLs are not accepted"));
      } catch (error) {
        const code = error instanceof GithubFailure && error.code === "authentication" ? "github-auth-unavailable" : "github-repository-unavailable";
        findings.push(finding(code, "repository", code === "github-auth-unavailable" ? "Host GitHub CLI authentication is unavailable" : "GitHub repository identity could not be verified"));
      }
    }
    if (findings.length > 0) throw new ProjectFailure("Project activation failed", findings, 422);
    const normalized: ProjectInput = {
      name: project.name,
      repositoryPath: project.repositoryPath,
      worktreeRoot: project.worktreeRoot,
      repository: project.repository!,
      baseBranch: project.baseBranch,
      targetBranch: project.targetBranch,
      setupCommand: project.setupCommand,
      verificationCommand: project.verificationCommand,
      requiredChecks: project.requiredChecks,
      allowedProfileIds: project.allowedProfileIds,
      roleDefaults: project.roleDefaults,
      baseSha: inspection?.baseSha,
      targetSha: inspection?.targetSha,
    };
    const identity = configIdentity(normalized);
    this.database.authTransaction((db) => {
      const now = this.now().toISOString();
      const existingRevision = db.prepare("SELECT id, revision FROM forge_project_revisions WHERE project_id = ? AND identity = ?").get(project.id, identity) as { id: string; revision: number } | undefined;
      const revisionId = existingRevision?.id ?? identifier("project-revision");
      const nextRevision = existingRevision?.revision ?? Number((db.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM forge_project_revisions WHERE project_id = ?").get(project.id) as { revision: number }).revision) + 1;
      if (!existingRevision) db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(revisionId, project.id, nextRevision, identity, JSON.stringify(normalized), normalized.baseSha ?? null, normalized.targetSha ?? null, actorUserId, now);
      db.prepare("UPDATE forge_projects SET repository_identity = ?, status = 'active', active_revision_id = ?, updated_at = ? WHERE id = ?").run(project.repository, revisionId, now, project.id);
      this.auth.recordAuditEventInTransaction(db, actorUserId, "project_activated", undefined, project.companyId, { projectId: project.id, revision: String(nextRevision), identity });
      return { revision: nextRevision, identity };
    });
    return this.getProject(actorUserId, project.id);
  }

  pauseProject(actorUserId: string, projectId: string): Project { return this.setProjectStatus(actorUserId, projectId, "paused"); }
  archiveProject(actorUserId: string, projectId: string): Project { return this.setProjectStatus(actorUserId, projectId, "archived"); }

  getProject(actorUserId: string, projectId: string): Project {
    const row = this.database.authQuery((db) => {
      const user = this.user(actorUserId);
      const result = user.role === "admin"
        ? db.prepare("SELECT p.*, COALESCE((SELECT MAX(revision) FROM forge_project_revisions r WHERE r.project_id = p.id), 0) AS configuration_revision, (SELECT identity FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS configuration_identity, (SELECT r.base_sha FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS base_sha, (SELECT r.target_sha FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS target_sha FROM forge_projects p WHERE p.id = ?").get(projectId)
        : db.prepare("SELECT p.*, COALESCE((SELECT MAX(revision) FROM forge_project_revisions r WHERE r.project_id = p.id), 0) AS configuration_revision, (SELECT identity FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS configuration_identity, (SELECT r.base_sha FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS base_sha, (SELECT r.target_sha FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS target_sha FROM forge_projects p JOIN forge_memberships m ON m.company_id = p.company_id WHERE p.id = ? AND m.user_id = ?").get(projectId, actorUserId);
      return result as ProjectRow | undefined;
    });
    if (!row) throw new ProjectFailure("Not found", [], 404);
    return publicProject(row);
  }

  listProjects(actorUserId: string, companyId?: string): Project[] {
    const rows = this.database.authQuery((db) => {
      const user = this.user(actorUserId);
      if (companyId) this.auth.requireCompanyAccess(actorUserId, companyId);
      const query = user.role === "admin"
        ? companyId ? db.prepare("SELECT p.*, COALESCE((SELECT MAX(revision) FROM forge_project_revisions r WHERE r.project_id = p.id), 0) AS configuration_revision, (SELECT identity FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS configuration_identity, (SELECT r.base_sha FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS base_sha, (SELECT r.target_sha FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS target_sha FROM forge_projects p WHERE p.company_id = ? ORDER BY p.name") : db.prepare("SELECT p.*, COALESCE((SELECT MAX(revision) FROM forge_project_revisions r WHERE r.project_id = p.id), 0) AS configuration_revision, (SELECT identity FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS configuration_identity, (SELECT r.base_sha FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS base_sha, (SELECT r.target_sha FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS target_sha FROM forge_projects p ORDER BY p.name")
        : companyId ? db.prepare("SELECT p.*, COALESCE((SELECT MAX(revision) FROM forge_project_revisions r WHERE r.project_id = p.id), 0) AS configuration_revision, (SELECT identity FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS configuration_identity, (SELECT r.base_sha FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS base_sha, (SELECT r.target_sha FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS target_sha FROM forge_projects p JOIN forge_memberships m ON m.company_id = p.company_id WHERE m.user_id = ? AND p.company_id = ? ORDER BY p.name") : db.prepare("SELECT p.*, COALESCE((SELECT MAX(revision) FROM forge_project_revisions r WHERE r.project_id = p.id), 0) AS configuration_revision, (SELECT identity FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS configuration_identity, (SELECT r.base_sha FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS base_sha, (SELECT r.target_sha FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS target_sha FROM forge_projects p JOIN forge_memberships m ON m.company_id = p.company_id WHERE m.user_id = ? ORDER BY p.name");
      const result = companyId ? user.role === "admin" ? query.all(companyId) : query.all(actorUserId, companyId) : user.role === "admin" ? query.all() : query.all(actorUserId);
      return result as ProjectRow[];
    });
    return rows.map(publicProject);
  }

  private async mutateProject(actorUserId: string, companyId: string, input: ProjectInput, updating: boolean, projectId?: string): Promise<Project> {
    const company = this.auth.requireCompanyAccess(actorUserId, companyId);
    if (company.status !== "active") throw new ProjectFailure("Company is not active", [finding("company-inactive", "companyId", "Project configuration requires an active company")], 409);
    const [repository, worktree] = await Promise.all([
      canonicalDirectory(input.repositoryPath, this.config.repositoryRoot, "repositoryPath"),
      canonicalDirectory(input.worktreeRoot, this.config.worktreeRoot, "worktreeRoot"),
    ]);
    const findings = [...repository.findings, ...worktree.findings];
    if (repository.path && worktree.path && (withinRoot(repository.path, worktree.path) || withinRoot(worktree.path, repository.path))) findings.push(finding("worktree-separation", "worktreeRoot", "Worktree root must be separate from the repository"));
    if (!namePattern.test(input.name.trim())) findings.push(finding("invalid-name", "name", "Project name is invalid"));
    if (!repositoryPattern.test(input.repository.trim().toLowerCase())) findings.push(finding("repository-identity", "repository", "Repository must use owner/name identity without credentials"));
    if (!branchPattern.test(input.baseBranch.trim())) findings.push(finding("unsafe-branch", "baseBranch", "Base branch is unsafe"));
    if (!branchPattern.test(input.targetBranch.trim())) findings.push(finding("unsafe-branch", "targetBranch", "Target branch is unsafe"));
    if (!isApprovedCommand(input.setupCommand, "setup")) findings.push(finding("unapproved-command", "setupCommand", "Setup must be one approved literal command"));
    if (!isApprovedCommand(input.verificationCommand, "verification")) findings.push(finding("unapproved-command", "verificationCommand", "Verification must be one approved literal command"));
    if (secretPattern.test(input.repository) || secretPattern.test(input.baseBranch) || secretPattern.test(input.targetBranch)) findings.push(finding("secret-shaped-value", "configuration", "Secret-shaped configuration values are not accepted"));
    if (!Array.isArray(input.requiredChecks) || input.requiredChecks.length === 0 || input.requiredChecks.length > 32 || input.requiredChecks.some((check) => !checkPattern.test(check.trim()))) findings.push(finding("invalid-check", "requiredChecks", "At least one safe required check is required"));
    if (!Array.isArray(input.allowedProfileIds) || input.allowedProfileIds.length === 0 || input.allowedProfileIds.length > 16) findings.push(finding("invalid-profiles", "allowedProfileIds", "At least one allowed profile is required"));
    if (worktree.path) {
      try { await access(worktree.path, constants.W_OK); } catch { findings.push(finding("worktree-unwritable", "worktreeRoot", "Worktree root must be writable")); }
    }
    const normalized = normalizedInput(input, { repositoryPath: repository.path ?? resolve(input.repositoryPath), worktreeRoot: worktree.path ?? resolve(input.worktreeRoot) });
    if (!normalized.roleDefaults.lead) findings.push(finding("missing-default", "roleDefaults.lead", "A Lead profile default is required"));
    if (!normalized.roleDefaults.developer) findings.push(finding("missing-default", "roleDefaults.developer", "A Developer profile default is required"));
    for (const [role, profileId] of Object.entries(normalized.roleDefaults)) if (!normalized.allowedProfileIds.includes(profileId)) findings.push(finding("profile-ineligible", `roleDefaults.${role}`, "Role defaults must reference an allowed profile"));
    if (findings.length) throw new ProjectFailure("Project configuration is invalid", findings, 422);
    const now = this.now().toISOString();
    let row: { id: string; revision: number; identity: string };
    try {
      row = this.database.authTransaction((db) => {
      const id = projectId ?? identifier("project");
      if (updating) {
        const existing = this.rowForProject(db, id);
        if (!existing || existing.company_id !== companyId) throw new ProjectFailure("Not found", [], 404);
        if (existing.status === "archived") throw new ProjectFailure("Project configuration is invalid", [finding("project-archived", "status", "Archived projects cannot be edited")], 409);
        db.prepare("UPDATE forge_projects SET name = ?, repository_path = ?, worktree_root = ?, repository_identity = ?, base_branch = ?, target_branch = ?, setup_command = ?, verification_command = ?, required_checks_json = ?, allowed_profiles_json = ?, role_defaults_json = ?, status = 'draft', active_revision_id = NULL, updated_at = ? WHERE id = ?").run(normalized.name, normalized.repositoryPath, normalized.worktreeRoot, normalized.repository, normalized.baseBranch, normalized.targetBranch, normalized.setupCommand, normalized.verificationCommand, JSON.stringify(normalized.requiredChecks), JSON.stringify(normalized.allowedProfileIds), JSON.stringify(normalized.roleDefaults), now, id);
      } else {
        db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, allowed_profiles_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?)").run(id, companyId, normalized.name, normalized.repositoryPath, normalized.worktreeRoot, normalized.repository, normalized.baseBranch, normalized.targetBranch, normalized.setupCommand, normalized.verificationCommand, JSON.stringify(normalized.requiredChecks), JSON.stringify(normalized.allowedProfileIds), JSON.stringify(normalized.roleDefaults), now, now);
      }
      const identity = configIdentity(normalized);
      const existingRevision = db.prepare("SELECT id, revision FROM forge_project_revisions WHERE project_id = ? AND identity = ?").get(id, identity) as { id: string; revision: number } | undefined;
      const revisionId = existingRevision?.id ?? identifier("project-revision");
      const revision = existingRevision?.revision ?? Number((db.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM forge_project_revisions WHERE project_id = ?").get(id) as { revision: number }).revision) + 1;
      if (!existingRevision) db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(revisionId, id, revision, identity, JSON.stringify(normalized), normalized.baseSha ?? null, normalized.targetSha ?? null, actorUserId, now);
        this.auth.recordAuditEventInTransaction(db, actorUserId, updating ? "project_updated" : "project_created", undefined, companyId, { projectId: id, revision: String(revision), identity });
        return { id, revision, identity };
      });
    } catch (error) {
      if (error instanceof Error && (error.message.includes("forge_projects.") || error.message.includes("forge_projects_repository_identity_unique"))) {
        const field = error.message.includes("repository_path") ? "repositoryPath" : error.message.includes("worktree_root") ? "worktreeRoot" : error.message.includes("repository_identity") ? "repository" : error.message.includes("company_id") && error.message.includes("name") ? "name" : undefined;
        if (!field) throw error;
        throw new ProjectFailure("Project configuration is invalid", [finding("already-assigned", field, "This coordinate is already assigned to another project")], 409);
      }
      throw error;
    }
    return this.getProject(actorUserId, row.id);
  }

  private setProjectStatus(actorUserId: string, projectId: string, status: "paused" | "archived"): Project {
    const project = this.getProject(actorUserId, projectId);
    if (project.status === "archived") throw new ProjectFailure("Project status change failed", [finding("project-archived", "status", "Archived projects cannot change status")], 409);
    this.database.authTransaction((db) => {
      db.prepare("UPDATE forge_projects SET status = ?, updated_at = ? WHERE id = ?").run(status, this.now().toISOString(), projectId);
      this.auth.recordAuditEventInTransaction(db, actorUserId, `project_${status}`, undefined, project.companyId, { projectId });
    });
    return this.getProject(actorUserId, projectId);
  }

  private rowForProject(db: import("better-sqlite3").Database, projectId: string): ProjectRow | undefined {
    return db.prepare("SELECT p.*, COALESCE((SELECT MAX(revision) FROM forge_project_revisions r WHERE r.project_id = p.id), 0) AS configuration_revision, (SELECT identity FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS configuration_identity, (SELECT r.base_sha FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS base_sha, (SELECT r.target_sha FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS target_sha FROM forge_projects p WHERE p.id = ?").get(projectId) as ProjectRow | undefined;
  }

  private user(userId: string): AuthUser {
    const user = this.auth.getUserForAuthority(userId);
    if (!user) throw new AuthFailure("Authentication required", 401);
    return user;
  }

  private requireAdmin(userId: string): AuthUser {
    const user = this.user(userId);
    if (user.role !== "admin") throw new AuthFailure("Administrator access required", 403);
    return user;
  }
}
