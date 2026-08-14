import { createHash, randomBytes } from "node:crypto";
import { access, constants, lstat, mkdir, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

import type { AuthUser } from "./auth.js";
import { AuthFailure, AuthService } from "./auth.js";
import type { ForgeConfig } from "./config.js";
import { GithubFailure, createGithubAdapter, type GithubAdapter } from "./github.js";
import { ForgeDatabase } from "./database.js";

const execFileAsync = promisify(execFile);

export type ProjectStatus = "draft" | "active" | "paused" | "needs-reactivation" | "archived";
export type ProjectRole = "analyst" | "implementer" | "reviewer";
export type RoleAssignments = Partial<Record<ProjectRole, string | undefined>>;
export type ReasoningLevel = "low" | "medium" | "high" | "xhigh";
export type ServicePriority = "standard" | "priority" | "fast";

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
  capacity: number | null;
  effectiveCapacity: number;
  createdAt: string;
  updatedAt: string;
}

type ProfileInput = { name: string; model: string; reasoningLevel: ReasoningLevel; servicePriority: ServicePriority; capacity?: number | null };

export interface Agent {
  id: string;
  name: string;
  role: ProjectRole;
  avatarSeed: string;
  profileId: string;
  createdAt: string;
  updatedAt: string;
}

export type AgentInput = { name: string; role: ProjectRole; avatarSeed?: string | undefined; profileId: string };

export type ModelStatus = "active" | "retired";

export interface CodexModel {
  id: string;
  displayName: string;
  description: string;
  status: ModelStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCheckOption {
  name: string;
  status: string;
  conclusion?: string;
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
  roleDefaults: RoleAssignments;
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
  roleDefaults: RoleAssignments;
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

export interface RepositoryProvisioner {
  ensure(input: { cloneUrl: string; repository: string; repositoryPath: string; worktreeRoot: string }): Promise<void>;
}

export interface GithubRepositoryCoordinate {
  cloneUrl: string;
  repository: string;
  name: string;
}

interface ProjectServiceOptions {
  github?: GithubAdapter;
  localRepository?: LocalRepositoryAdapter;
  repositoryProvisioner?: RepositoryProvisioner;
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
  role_defaults_json: string;
  status: ProjectStatus;
  active_revision_id: string | null;
  created_at: string;
  updated_at: string;
  configuration_revision?: number;
  configuration_identity?: string;
  base_sha?: string | null;
  target_sha?: string | null;
  active_revision_state?: "draft" | "accepted" | null;
}

interface ProfileRow {
  id: string;
  name: string;
  provider: "codex";
  model: string;
  reasoning_level: ReasoningLevel;
  service_priority: ServicePriority;
  capacity: number | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRow {
  id: string;
  name: string;
  role: ProjectRole;
  avatar_seed: string;
  profile_id: string;
  created_at: string;
  updated_at: string;
}

interface ModelRow {
  model_id: string;
  display_name: string;
  description: string;
  status: ModelStatus;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const namePattern = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._'-]{0,78}[\p{L}\p{N}])?$/u;
const repositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;
const branchPattern = /^(?![./])(?!.*(?:\.\.|\.$|\.lock$|\/\/|\s|[~^:?*\[\\]))[A-Za-z0-9._/-]+$/;
const checkPattern = /^[\p{L}\p{N}][\p{L}\p{N} ._:/()\[\]-]{0,119}$/u;
const secretPattern = /(?:gh[pousr]_|github_pat_|token\s*=|password\s*=|secret\s*=|BEGIN [A-Z ]+ PRIVATE KEY|sk-[A-Za-z0-9])/i;
const modelIdPattern = /^[a-z0-9][a-z0-9._-]{1,119}$/;
const avatarSeedPattern = /^[a-f0-9]{32}$/;
const approvedSetupCommands = new Set(["pnpm install", "pnpm install --frozen-lockfile", "npm install", "npm ci", "yarn install", "yarn install --immutable", "bun install", "mise run setup", "cargo fetch --locked"]);
const approvedVerificationCommands = new Set(["pnpm test", "pnpm typecheck", "pnpm lint", "npm test", "npm run typecheck", "npm run lint", "yarn test", "yarn typecheck", "yarn lint", "bun test", "mise run test", "mise run typecheck", "mise run lint", "cargo test", "make test", "make check"]);

export const AcceptedProjectRevisionSchema = z.object({
  repositoryPath: z.string().min(1).max(1_000),
  worktreeRoot: z.string().min(1).max(1_000),
  repository: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9][a-z0-9_.-]{0,99}$/),
  baseBranch: z.string().min(1).max(256),
  targetBranch: z.string().min(1).max(256),
  baseSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  targetSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  setupCommand: z.string().refine((value) => approvedSetupCommands.has(value), "Setup command is not an accepted project command"),
  verificationCommand: z.string().refine((value) => approvedVerificationCommands.has(value), "Verification command is not an accepted project command"),
  requiredChecks: z.array(z.string().min(1).max(120)).max(32),
});
export type AcceptedProjectRevision = z.infer<typeof AcceptedProjectRevisionSchema>;

export function parseAcceptedProjectRevision(raw: string): AcceptedProjectRevision {
  try {
    return AcceptedProjectRevisionSchema.parse(JSON.parse(raw));
  } catch {
    throw new ProjectFailure("Pinned project revision is unavailable", [], 409);
  }
}

const projectRevisionColumns = `p.*, COALESCE((SELECT MAX(revision) FROM forge_project_revisions r WHERE r.project_id = p.id AND r.state = 'accepted'), 0) AS configuration_revision, (SELECT identity FROM forge_project_revisions r WHERE r.id = p.active_revision_id AND r.state = 'accepted') AS configuration_identity, (SELECT r.base_sha FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS base_sha, (SELECT r.target_sha FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS target_sha, (SELECT r.state FROM forge_project_revisions r WHERE r.id = p.active_revision_id) AS active_revision_state`;

function identifier(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function withinRoot(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

async function containsSymlink(root: string, candidate: string): Promise<boolean> {
  const path = relative(root, candidate);
  if (path === "" || path.startsWith(`..${sep}`) || path === "..") return false;
  let current = root;
  for (const segment of path.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) return true;
  }
  return false;
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
    roleDefaults: Object.fromEntries(Object.entries(input.roleDefaults).flatMap(([role, profileId]) => typeof profileId === "string" && profileId.trim().length > 0 ? [[role, profileId.trim()] as [string, string]] : []).sort(([left], [right]) => left.localeCompare(right))) as RoleAssignments,
  };
  return normalized;
}

function configIdentity(input: ProjectInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function effectiveProfileCapacity(profile: Pick<CodexProfile, "capacity">, config: Pick<ForgeConfig, "externalTurnCapacity">): number {
  return profile.capacity ?? config.externalTurnCapacity;
}

function publicProfile(row: ProfileRow, config: Pick<ForgeConfig, "externalTurnCapacity">): CodexProfile {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    reasoningLevel: row.reasoning_level,
    servicePriority: row.service_priority,
    capacity: row.capacity,
    effectiveCapacity: effectiveProfileCapacity(row, config),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function publicAgent(row: AgentRow): Agent {
  return { id: row.id, name: row.name, role: row.role, avatarSeed: row.avatar_seed, profileId: row.profile_id, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function resolveAgentProfiles(db: import("better-sqlite3").Database, roleAgents: RoleAssignments): RoleAssignments {
  const resolved: RoleAssignments = {};
  for (const [role, agentId] of Object.entries(roleAgents)) {
    if (!agentId) continue;
    const agent = db.prepare("SELECT profile_id FROM forge_agents WHERE id = ? AND role = ?").get(agentId, role) as { profile_id: string } | undefined;
    if (agent) resolved[role as ProjectRole] = agent.profile_id;
  }
  return resolved;
}

function publicModel(row: ModelRow): CodexModel {
  return { id: row.model_id, displayName: row.display_name, description: row.description, status: row.status, sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at };
}

function publicProject(row: ProjectRow): Project {
  const needsReactivation = row.status === "active" && Boolean(row.active_revision_id) && (!row.base_sha || !row.target_sha);
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
    roleDefaults: asJson<RoleAssignments>(row.role_defaults_json, {}),
    status: needsReactivation ? "needs-reactivation" : row.status,
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

async function readableFile(path: string): Promise<string | undefined> {
  try {
    return await (await import("node:fs/promises")).readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function hasMiseTask(configuration: string, task: string): boolean {
  const escaped = task.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\[tasks\\.(?:${escaped}|["']${escaped}["'])\\]`, "m").test(configuration);
}

export async function inferRepositoryCommands(repositoryPath: string): Promise<{ setupCommand: string; verificationCommand: string }> {
  const miseConfiguration = await readableFile(join(repositoryPath, "mise.toml")) ?? await readableFile(join(repositoryPath, ".mise.toml"));
  const packageText = await readableFile(join(repositoryPath, "package.json"));
  let packageJson: { packageManager?: string; scripts?: Record<string, string> } | undefined;
  try {
    packageJson = packageText ? JSON.parse(packageText) as typeof packageJson : undefined;
  } catch {}

  let packageManager: "pnpm" | "npm" | "yarn" | "bun" | undefined;
  let setupCommand: string | undefined;
  if (await fileExists(join(repositoryPath, "pnpm-lock.yaml"))) {
    packageManager = "pnpm";
    setupCommand = "pnpm install --frozen-lockfile";
  } else if (await fileExists(join(repositoryPath, "package-lock.json")) || await fileExists(join(repositoryPath, "npm-shrinkwrap.json"))) {
    packageManager = "npm";
    setupCommand = "npm ci";
  } else if (await fileExists(join(repositoryPath, "yarn.lock"))) {
    packageManager = "yarn";
    setupCommand = "yarn install --immutable";
  } else if (await fileExists(join(repositoryPath, "bun.lock")) || await fileExists(join(repositoryPath, "bun.lockb"))) {
    packageManager = "bun";
    setupCommand = "bun install";
  } else if (packageJson) {
    const declaredManager = packageJson.packageManager?.split("@")[0];
    packageManager = declaredManager === "pnpm" || declaredManager === "yarn" || declaredManager === "bun" ? declaredManager : "npm";
    setupCommand = packageManager === "pnpm" ? "pnpm install" : packageManager === "npm" ? "npm install" : packageManager === "yarn" ? "yarn install" : "bun install";
  } else if (miseConfiguration && hasMiseTask(miseConfiguration, "setup")) {
    setupCommand = "mise run setup";
  } else if (await fileExists(join(repositoryPath, "Cargo.lock"))) {
    setupCommand = "cargo fetch --locked";
  }

  const scripts = packageJson?.scripts ?? {};
  const script = ["test", "typecheck", "lint"].find((name) => Boolean(scripts[name]));
  let verificationCommand: string | undefined;
  if (script && packageManager) {
    verificationCommand = packageManager === "npm" ? (script === "test" ? "npm test" : `npm run ${script}`) : `${packageManager} ${script}`;
  } else if (miseConfiguration) {
    const miseTask = ["test", "typecheck", "lint"].find((name) => hasMiseTask(miseConfiguration, name));
    if (miseTask) verificationCommand = `mise run ${miseTask}`;
  } else if (await fileExists(join(repositoryPath, "Cargo.toml"))) {
    verificationCommand = "cargo test";
  } else {
    const makefile = await readableFile(join(repositoryPath, "Makefile"));
    if (makefile && /^test\s*:/m.test(makefile)) verificationCommand = "make test";
    else if (makefile && /^check\s*:/m.test(makefile)) verificationCommand = "make check";
  }

  return {
    setupCommand: setupCommand ?? "pnpm install",
    verificationCommand: verificationCommand ?? "pnpm test",
  };
}

function githubRepositoryCoordinate(rawUrl: string): GithubRepositoryCoordinate | undefined {
  const trimmed = rawUrl.trim();
  const normalizedSsh = trimmed.replace(/\.git$/, "");
  const ssh = /^git@github\.com:([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/.exec(normalizedSsh);
  if (ssh?.[1] && ssh[2]) {
    const repository = `${ssh[1]}/${ssh[2]}`.toLowerCase();
    return { cloneUrl: `git@github.com:${repository}.git`, repository, name: ssh[2] };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    const normalizedPath = parsed.pathname.replace(/\/$/, "").replace(/\.git$/, "");
    const match = /^\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/.exec(normalizedPath);
    if (!match?.[1] || !match[2]) return undefined;
    const repository = `${match[1]}/${match[2]}`.toLowerCase();
    return { cloneUrl: `https://github.com/${repository}.git`, repository, name: match[2] };
  } catch {
    return undefined;
  }
}

export function parseGithubRepositoryUrl(rawUrl: string): GithubRepositoryCoordinate {
  const coordinate = githubRepositoryCoordinate(rawUrl);
  if (!coordinate || secretPattern.test(rawUrl)) {
    throw new ProjectFailure("GitHub repository URL is invalid", [finding("repository-url", "repositoryUrl", "Use an HTTPS or SSH URL for one GitHub repository")], 422);
  }
  return coordinate;
}

function githubRepositoryFromRemote(remoteUrl: string): { identity: string; credentialBearing: boolean } | undefined {
  const trimmed = remoteUrl.trim();
  const coordinate = githubRepositoryCoordinate(trimmed);
  if (coordinate) return { identity: coordinate.repository, credentialBearing: false };
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
    const match = /^\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/.exec(parsed.pathname.replace(/\.git$/, ""));
    return match?.[1] ? { identity: match[1].toLowerCase(), credentialBearing: Boolean(parsed.username || parsed.password) } : undefined;
  } catch {
    return undefined;
  }
}

function defaultRepositoryProvisioner(): RepositoryProvisioner {
  const git = async (args: string[], cwd?: string): Promise<string> => {
    const result = await execFileAsync("git", args, { ...(cwd ? { cwd } : {}), timeout: 120_000, maxBuffer: 64 * 1024 });
    return result.stdout.trim();
  };
  return {
    async ensure(input) {
      await mkdir(dirname(input.repositoryPath), { recursive: true });
      let repositoryExists = false;
      try {
        repositoryExists = (await stat(input.repositoryPath)).isDirectory();
      } catch {}
      if (repositoryExists) {
        try {
          const remoteUrl = await git(["remote", "get-url", "origin"], input.repositoryPath);
          const remote = githubRepositoryFromRemote(remoteUrl);
          if (!remote || remote.credentialBearing || remote.identity !== input.repository) throw new Error("origin mismatch");
        } catch {
          throw new ProjectFailure("Repository provisioning failed", [finding("repository-conflict", "repositoryUrl", "The default repository path already exists and does not match this GitHub repository")], 409);
        }
      } else {
        const temporaryPath = await mkdtemp(join(dirname(input.repositoryPath), ".forge-clone-"));
        try {
          await git(["clone", "--origin", "origin", "--", input.cloneUrl, temporaryPath]);
          await rename(temporaryPath, input.repositoryPath);
        } catch {
          await rm(temporaryPath, { recursive: true, force: true });
          throw new ProjectFailure("Repository provisioning failed", [finding("repository-unavailable", "repositoryUrl", "Git could not clone the repository with the host's current credentials")], 422);
        }
      }
      await mkdir(input.worktreeRoot, { recursive: true });
    },
  };
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
    const [root, canonical, symlinked] = await Promise.all([realpath(rootAbsolute), realpath(absolute), containsSymlink(rootAbsolute, absolute)]);
    if (symlinked) {
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
  private readonly repositoryProvisioner: RepositoryProvisioner;

  constructor(
    private readonly database: ForgeDatabase,
    private readonly auth: AuthService,
    private readonly config: ForgeConfig,
    options: ProjectServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.github = options.github ?? createGithubAdapter();
    this.localRepositoryPromise = options.localRepository ? Promise.resolve(options.localRepository) : defaultLocalRepositoryAdapter();
    this.repositoryProvisioner = options.repositoryProvisioner ?? defaultRepositoryProvisioner();
  }

  private validateProfileInput(input: ProfileInput): Required<ProfileInput> {
    const name = input.name.trim();
    const model = input.model.trim();
    const capacity = input.capacity ?? null;
    if (!namePattern.test(name)) throw new ProjectFailure("Profile configuration is invalid", [finding("invalid-name", "name", "Profile name is invalid")]);
    const catalogModel = this.database.authQuery((db) => db.prepare("SELECT model_id FROM forge_models WHERE model_id = ? AND status = 'active'").get(model) as { model_id: string } | undefined);
    if (!modelIdPattern.test(model) || secretPattern.test(model) || !catalogModel) throw new ProjectFailure("Profile configuration is invalid", [finding("invalid-model", "model", "Select an active model from the catalog")]);
    if (!["low", "medium", "high", "xhigh"].includes(input.reasoningLevel)) throw new ProjectFailure("Profile configuration is invalid", [finding("invalid-reasoning", "reasoningLevel", "Reasoning level is invalid")]);
    if (!["standard", "priority", "fast"].includes(input.servicePriority)) throw new ProjectFailure("Profile configuration is invalid", [finding("invalid-priority", "servicePriority", "Service priority is invalid")]);
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 32)) throw new ProjectFailure("Profile configuration is invalid", [finding("invalid-capacity", "capacity", "Capacity must be an integer from 1 to 32")]);
    return { name, model, reasoningLevel: input.reasoningLevel, servicePriority: input.servicePriority, capacity };
  }

  createProfile(actorUserId: string, input: ProfileInput): CodexProfile {
    const actor = this.requireAdmin(actorUserId);
    void actor;
    const profileInput = this.validateProfileInput(input);
    const now = this.now().toISOString();
    const profile = { id: identifier("profile"), name: profileInput.name, provider: "codex" as const, model: profileInput.model, reasoningLevel: profileInput.reasoningLevel, capacity: profileInput.capacity, servicePriority: profileInput.servicePriority, effectiveCapacity: profileInput.capacity ?? this.config.externalTurnCapacity, createdAt: now, updatedAt: now };
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

  updateProfile(actorUserId: string, profileId: string, input: ProfileInput): CodexProfile {
    this.requireAdmin(actorUserId);
    const profileInput = this.validateProfileInput(input);
    const now = this.now().toISOString();
    try {
      const changed = this.database.authTransaction((db) => {
        const result = db.prepare("UPDATE forge_profiles SET name = ?, model = ?, reasoning_level = ?, service_priority = ?, capacity = ?, updated_at = ? WHERE id = ?").run(profileInput.name, profileInput.model, profileInput.reasoningLevel, profileInput.servicePriority, profileInput.capacity, now, profileId);
        if (result.changes !== 1) throw new ProjectFailure("Profile not found", [], 404);
        this.auth.recordAuditEventInTransaction(db, actorUserId, "profile_updated", undefined, undefined, { profileId });
        return db.prepare("SELECT * FROM forge_profiles WHERE id = ?").get(profileId) as ProfileRow;
      });
      return publicProfile(changed, this.config);
    } catch (error) {
      if (error instanceof ProjectFailure) throw error;
      throw new ProjectFailure("Profile configuration is invalid", [finding("duplicate-name", "name", "Profile name is already in use")], 409);
    }
  }

  listProfiles(actorUserId: string): CodexProfile[] {
    this.user(actorUserId);
    return this.database.authQuery((db) => (db.prepare("SELECT * FROM forge_profiles ORDER BY name").all() as ProfileRow[]).map((row) => publicProfile(row, this.config)));
  }

  private validateAgentInput(input: AgentInput): Required<AgentInput> {
    const name = input.name.trim();
    const profileId = input.profileId.trim();
    if (!namePattern.test(name)) throw new ProjectFailure("Agent configuration is invalid", [finding("invalid-name", "name", "Agent name is invalid")]);
    if (!(["analyst", "implementer", "reviewer"] as ProjectRole[]).includes(input.role)) throw new ProjectFailure("Agent configuration is invalid", [finding("invalid-role", "role", "Agent role is invalid")]);
    const profile = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_profiles WHERE id = ?").get(profileId) as { id: string } | undefined);
    if (!profile) throw new ProjectFailure("Agent configuration is invalid", [finding("profile-unavailable", "profileId", "Agent profile is unavailable")]);
    if (input.avatarSeed !== undefined && !avatarSeedPattern.test(input.avatarSeed)) throw new ProjectFailure("Agent configuration is invalid", [finding("invalid-avatar", "avatarSeed", "Avatar seed is invalid")]);
    return { name, role: input.role, avatarSeed: input.avatarSeed ?? randomBytes(16).toString("hex"), profileId };
  }

  createAgent(actorUserId: string, input: AgentInput): Agent {
    this.requireAdmin(actorUserId);
    const agentInput = this.validateAgentInput(input);
    const now = this.now().toISOString();
    const id = identifier("agent");
    try {
      this.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_agents (id, name, role, avatar_seed, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, agentInput.name, agentInput.role, agentInput.avatarSeed, agentInput.profileId, now, now);
        this.auth.recordAuditEventInTransaction(db, actorUserId, "agent_created", undefined, undefined, { agentId: id });
      });
    } catch {
      throw new ProjectFailure("Agent configuration is invalid", [finding("duplicate-name", "name", "Agent name is already in use")], 409);
    }
    return this.database.authQuery((db) => publicAgent(db.prepare("SELECT * FROM forge_agents WHERE id = ?").get(id) as AgentRow));
  }

  updateAgent(actorUserId: string, agentId: string, input: AgentInput): Agent {
    this.requireAdmin(actorUserId);
    const agentInput = this.validateAgentInput(input);
    const now = this.now().toISOString();
    try {
      return this.database.authTransaction((db) => {
        const result = db.prepare("UPDATE forge_agents SET name = ?, role = ?, avatar_seed = ?, profile_id = ?, updated_at = ? WHERE id = ?").run(agentInput.name, agentInput.role, agentInput.avatarSeed, agentInput.profileId, now, agentId);
        if (result.changes !== 1) throw new ProjectFailure("Agent not found", [], 404);
        this.auth.recordAuditEventInTransaction(db, actorUserId, "agent_updated", undefined, undefined, { agentId });
        return publicAgent(db.prepare("SELECT * FROM forge_agents WHERE id = ?").get(agentId) as AgentRow);
      });
    } catch (error) {
      if (error instanceof ProjectFailure) throw error;
      throw new ProjectFailure("Agent configuration is invalid", [finding("duplicate-name", "name", "Agent name is already in use")], 409);
    }
  }

  listAgents(actorUserId: string): Agent[] {
    this.user(actorUserId);
    return this.database.authQuery((db) => (db.prepare("SELECT * FROM forge_agents ORDER BY role, name").all() as AgentRow[]).map(publicAgent));
  }

  updateProfileCapacity(actorUserId: string, profileId: string, capacity: number | null): CodexProfile {
    this.requireAdmin(actorUserId);
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 32)) throw new ProjectFailure("Profile configuration is invalid", [finding("invalid-capacity", "capacity", "Capacity must be an integer from 1 to 32")]);
    const now = this.now().toISOString();
    const changed = this.database.authTransaction((db) => {
      const result = db.prepare("UPDATE forge_profiles SET capacity = ?, updated_at = ? WHERE id = ?").run(capacity, now, profileId);
      if (result.changes !== 1) throw new ProjectFailure("Profile not found", [], 404);
      this.auth.recordAuditEventInTransaction(db, actorUserId, "profile_capacity_updated", undefined, undefined, { profileId, capacityMode: capacity === null ? "default" : "override" });
      return db.prepare("SELECT * FROM forge_profiles WHERE id = ?").get(profileId) as ProfileRow;
    });
    return publicProfile(changed, this.config);
  }

  listModels(actorUserId: string, includeRetired = false): CodexModel[] {
    if (includeRetired) this.requireAdmin(actorUserId);
    else this.user(actorUserId);
    return this.database.authQuery((db) => {
      const rows = (includeRetired
        ? db.prepare("SELECT * FROM forge_models ORDER BY sort_order, model_id").all()
        : db.prepare("SELECT * FROM forge_models WHERE status = 'active' ORDER BY sort_order, model_id").all()) as ModelRow[];
      return rows.map(publicModel);
    });
  }

  createModel(actorUserId: string, input: { id: string; displayName: string; description?: string; sortOrder?: number }): CodexModel {
    this.requireAdmin(actorUserId);
    const id = input.id.trim().toLowerCase();
    const displayName = input.displayName.trim();
    const description = input.description?.trim() ?? "";
    const sortOrder = input.sortOrder ?? 100;
    if (!modelIdPattern.test(id) || !displayName || displayName.length > 120 || description.length > 240 || !Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10_000) {
      throw new ProjectFailure("Model configuration is invalid", [finding("invalid-model", "model", "Use a valid model ID, display name, and sort order")]);
    }
    const now = this.now().toISOString();
    try {
      this.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_models (model_id, display_name, description, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)").run(id, displayName, description, sortOrder, now, now);
        this.auth.recordAuditEventInTransaction(db, actorUserId, "model_created", undefined, undefined, { modelId: id });
      });
    } catch {
      throw new ProjectFailure("Model configuration is invalid", [finding("duplicate-model", "model", "Model ID is already in the catalog")], 409);
    }
    return this.database.authQuery((db) => publicModel(db.prepare("SELECT * FROM forge_models WHERE model_id = ?").get(id) as ModelRow));
  }

  setModelStatus(actorUserId: string, modelId: string, status: ModelStatus): CodexModel {
    this.requireAdmin(actorUserId);
    if (!modelIdPattern.test(modelId) || !["active", "retired"].includes(status)) throw new ProjectFailure("Model configuration is invalid", [finding("invalid-model", "model", "Model ID or status is invalid")]);
    const now = this.now().toISOString();
    this.database.authTransaction((db) => {
      const result = db.prepare("UPDATE forge_models SET status = ?, updated_at = ? WHERE model_id = ?").run(status, now, modelId);
      if (result.changes === 0) throw new ProjectFailure("Not found", [], 404);
      this.auth.recordAuditEventInTransaction(db, actorUserId, status === "active" ? "model_restored" : "model_retired", undefined, undefined, { modelId });
    });
    return this.database.authQuery((db) => publicModel(db.prepare("SELECT * FROM forge_models WHERE model_id = ?").get(modelId) as ModelRow));
  }

  async listProjectChecks(actorUserId: string, projectId: string): Promise<ProjectCheckOption[]> {
    const project = this.getProject(actorUserId, projectId);
    if (!project.repository) return [];
    try {
      await this.github.checkAuthentication();
      if (!this.github.listChecks) throw new GithubFailure("command");
      return await this.github.listChecks({ cwd: project.repositoryPath, nameWithOwner: project.repository, ref: project.targetBranch });
    } catch (error) {
      const code = error instanceof GithubFailure && error.code === "authentication" ? "github-auth-unavailable" : "github-checks-unavailable";
      throw new ProjectFailure("GitHub checks are unavailable", [finding(code, "requiredChecks", code === "github-auth-unavailable" ? "Host GitHub CLI authentication is unavailable" : "GitHub did not return checks for the target branch")], 422);
    }
  }

  async getProjectRepositoryDefaults(actorUserId: string, projectId: string): Promise<{ setupCommand: string; verificationCommand: string }> {
    const project = this.getProject(actorUserId, projectId);
    return inferRepositoryCommands(project.repositoryPath);
  }

  createProject(actorUserId: string, companyId: string, input: ProjectInput): Promise<Project> {
    return this.mutateProject(actorUserId, companyId, input, false, undefined, true);
  }

  async createProjectFromRepository(actorUserId: string, companyId: string, repositoryUrl: string): Promise<Project> {
    const company = this.auth.requireCompanyAccess(actorUserId, companyId);
    if (company.status !== "active") throw new ProjectFailure("Company is not active", [finding("company-inactive", "companyId", "Project configuration requires an active company")], 409);
    const coordinate = parseGithubRepositoryUrl(repositoryUrl);
    const [owner, repositoryName] = coordinate.repository.split("/");
    if (!owner || !repositoryName) throw new ProjectFailure("GitHub repository URL is invalid", [finding("repository-url", "repositoryUrl", "Use an HTTPS or SSH URL for one GitHub repository")], 422);
    const repositoryPath = resolve(this.config.repositoryRoot, owner, repositoryName);
    const worktreeRoot = resolve(this.config.worktreeRoot, owner, repositoryName);
    if (!withinRoot(repositoryPath, resolve(this.config.repositoryRoot)) || !withinRoot(worktreeRoot, resolve(this.config.worktreeRoot))) {
      throw new ProjectFailure("Repository provisioning failed", [finding("path-outside-root", "repositoryUrl", "Derived project paths escaped the configured Forge roots")], 422);
    }
    await this.repositoryProvisioner.ensure({ cloneUrl: coordinate.cloneUrl, repository: coordinate.repository, repositoryPath, worktreeRoot });
    const commands = await inferRepositoryCommands(repositoryPath);
    let requiredChecks: string[] = [];
    try {
      await this.github.checkAuthentication();
      requiredChecks = this.github.listChecks
        ? [...new Set((await this.github.listChecks({ cwd: repositoryPath, nameWithOwner: coordinate.repository, ref: "main" })).map((check) => check.name))]
        : [];
    } catch {}
    const agents = this.listAgents(actorUserId);
    const roleDefaults = Object.fromEntries(([
      ["analyst", agents.find((agent) => agent.role === "analyst")?.id],
      ["implementer", agents.find((agent) => agent.role === "implementer")?.id],
      ["reviewer", agents.find((agent) => agent.role === "reviewer")?.id],
    ] as const).filter((entry) => Boolean(entry[1]))) as RoleAssignments;
    const draft = await this.mutateProject(actorUserId, companyId, {
      name: coordinate.name,
      repositoryPath,
      worktreeRoot,
      repository: coordinate.repository,
      baseBranch: "main",
      targetBranch: "main",
      setupCommand: commands.setupCommand,
      verificationCommand: commands.verificationCommand,
      requiredChecks,
      roleDefaults,
    }, false, undefined, true);
    try {
      return await this.activateProject(actorUserId, draft.id);
    } catch (error) {
      if (error instanceof ProjectFailure) return draft;
      throw error;
    }
  }

  async updateProject(actorUserId: string, projectId: string, input: ProjectInput): Promise<Project> {
    const existing = this.getProject(actorUserId, projectId);
    return this.mutateProject(actorUserId, existing.companyId, input, true, projectId, true);
  }

  async activateProject(actorUserId: string, projectId: string): Promise<Project> {
    const project = this.getProject(actorUserId, projectId);
    const company = this.auth.requireCompanyAccess(actorUserId, project.companyId);
    if (company.status !== "active") throw new ProjectFailure("Project activation failed", [finding("company-inactive", "companyId", "Project activation requires an active company")], 409);
    if (project.status === "archived") throw new ProjectFailure("Project activation failed", [finding("project-archived", "status", "Archived projects cannot be activated")], 409);
    const findings: ProjectFinding[] = [];
    const local = await this.localRepositoryPromise;
    const agents = this.database.authQuery((db) => db.prepare("SELECT id, role FROM forge_agents").all() as Array<{ id: string; role: ProjectRole }>);
    const agentRoles = new Map(agents.map((agent) => [agent.id, agent.role]));
    for (const role of ["analyst", "implementer", "reviewer"] as const) {
      const agentId = project.roleDefaults[role];
      if (!agentId) findings.push(finding("missing-default", `roleDefaults.${role}`, `An ${role} agent default is required`));
      else if (agentRoles.get(agentId) !== role) findings.push(finding("agent-ineligible", `roleDefaults.${role}`, "Role defaults must reference an agent with the matching role"));
    }
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
      if (inspection.baseSha && !/^[a-f0-9]{40,64}$/i.test(inspection.baseSha)) findings.push(finding("base-sha-invalid", "baseBranch", "Base branch must resolve to an exact Git commit SHA"));
      if (inspection.targetSha && !/^[a-f0-9]{40,64}$/i.test(inspection.targetSha)) findings.push(finding("target-sha-invalid", "targetBranch", "Target branch must resolve to an exact Git commit SHA"));
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
        const code = error instanceof GithubFailure
          ? error.code === "authentication" ? "github-auth-unavailable" : error.code === "repository" ? "github-repository-unavailable" : "github-command-failed"
          : "github-repository-unavailable";
        findings.push(finding(code, "repository", code === "github-auth-unavailable" ? "Host GitHub CLI authentication is unavailable" : code === "github-command-failed" ? "The host GitHub CLI could not complete a read-only validation" : "GitHub repository identity could not be verified"));
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
      roleDefaults: project.roleDefaults,
      baseSha: inspection?.baseSha,
      targetSha: inspection?.targetSha,
    };
    const identity = configIdentity(normalized);
    this.database.authTransaction((db) => {
      const now = this.now().toISOString();
      const existingRevision = db.prepare("SELECT id, revision FROM forge_project_revisions WHERE project_id = ? AND identity = ? AND state = 'accepted'").get(project.id, identity) as { id: string; revision: number } | undefined;
      const revisionId = existingRevision?.id ?? identifier("project-revision");
      const nextRevision = existingRevision?.revision ?? Number((db.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM forge_project_revisions WHERE project_id = ?").get(project.id) as { revision: number }).revision) + 1;
      if (!existingRevision) db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, state, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)").run(revisionId, project.id, nextRevision, identity, JSON.stringify(normalized), normalized.baseSha, normalized.targetSha, actorUserId, now);
      db.prepare("UPDATE forge_projects SET repository_identity = ?, status = 'active', active_revision_id = ?, updated_at = ? WHERE id = ?").run(project.repository, revisionId, now, project.id);
      this.auth.recordAuditEventInTransaction(db, actorUserId, "project_activated", undefined, project.companyId, { projectId: project.id, revision: String(nextRevision), identity });
      return { revision: nextRevision, identity };
    });
    return this.getProject(actorUserId, project.id);
  }

  pauseProject(actorUserId: string, projectId: string): Project { return this.setProjectStatus(actorUserId, projectId, "paused"); }
  archiveProject(actorUserId: string, projectId: string): Project { return this.setProjectStatus(actorUserId, projectId, "archived"); }
  reactivateProject(actorUserId: string, projectId: string): Promise<Project> { return this.activateProject(actorUserId, projectId); }

  getProject(actorUserId: string, projectId: string): Project {
    const row = this.database.authQuery((db) => {
      const user = this.user(actorUserId);
      const result = user.role === "admin"
        ? db.prepare(`SELECT ${projectRevisionColumns} FROM forge_projects p WHERE p.id = ?`).get(projectId)
        : db.prepare(`SELECT ${projectRevisionColumns} FROM forge_projects p JOIN forge_memberships m ON m.company_id = p.company_id WHERE p.id = ? AND m.user_id = ?`).get(projectId, actorUserId);
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
        ? companyId ? db.prepare(`SELECT ${projectRevisionColumns} FROM forge_projects p WHERE p.company_id = ? ORDER BY p.name`) : db.prepare(`SELECT ${projectRevisionColumns} FROM forge_projects p ORDER BY p.name`)
        : companyId ? db.prepare(`SELECT ${projectRevisionColumns} FROM forge_projects p JOIN forge_memberships m ON m.company_id = p.company_id WHERE m.user_id = ? AND p.company_id = ? ORDER BY p.name`) : db.prepare(`SELECT ${projectRevisionColumns} FROM forge_projects p JOIN forge_memberships m ON m.company_id = p.company_id WHERE m.user_id = ? ORDER BY p.name`);
      const result = companyId ? user.role === "admin" ? query.all(companyId) : query.all(actorUserId, companyId) : user.role === "admin" ? query.all() : query.all(actorUserId);
      return result as ProjectRow[];
    });
    return rows.map(publicProject);
  }

  private async mutateProject(actorUserId: string, companyId: string, input: ProjectInput, updating: boolean, projectId?: string, allowIncompleteDraft = false): Promise<Project> {
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
    if (!Array.isArray(input.requiredChecks) || (!allowIncompleteDraft && input.requiredChecks.length === 0) || input.requiredChecks.length > 32 || input.requiredChecks.some((check) => !checkPattern.test(check.trim()))) findings.push(finding("invalid-check", "requiredChecks", "At least one safe required check is required"));
    if (worktree.path) {
      try { await access(worktree.path, constants.W_OK); } catch { findings.push(finding("worktree-unwritable", "worktreeRoot", "Worktree root must be writable")); }
    }
    const normalized = normalizedInput(input, { repositoryPath: repository.path ?? resolve(input.repositoryPath), worktreeRoot: worktree.path ?? resolve(input.worktreeRoot) });
    const agentRows = this.database.authQuery((db) => db.prepare("SELECT id, role FROM forge_agents").all() as Array<{ id: string; role: ProjectRole }>);
    const agentRoles = new Map(agentRows.map((agent) => [agent.id, agent.role]));
    for (const role of ["analyst", "implementer", "reviewer"] as const) {
      const agentId = normalized.roleDefaults[role];
      if (!allowIncompleteDraft && !agentId) findings.push(finding("missing-default", `roleDefaults.${role}`, `An ${role} agent default is required`));
      else if (agentId && agentRoles.get(agentId) !== role) findings.push(finding("agent-ineligible", `roleDefaults.${role}`, "Role defaults must reference an agent with the matching role"));
    }
    if (findings.length) throw new ProjectFailure("Project configuration is invalid", findings, 422);
    const now = this.now().toISOString();
    let row: { id: string };
    try {
      row = this.database.authTransaction((db) => {
      const id = projectId ?? identifier("project");
      if (updating) {
        const existing = this.rowForProject(db, id);
        if (!existing || existing.company_id !== companyId) throw new ProjectFailure("Not found", [], 404);
        if (existing.status === "archived") throw new ProjectFailure("Project configuration is invalid", [finding("project-archived", "status", "Archived projects cannot be edited")], 409);
        db.prepare("UPDATE forge_projects SET name = ?, repository_path = ?, worktree_root = ?, repository_identity = ?, base_branch = ?, target_branch = ?, setup_command = ?, verification_command = ?, required_checks_json = ?, role_defaults_json = ?, status = 'draft', active_revision_id = NULL, updated_at = ? WHERE id = ?").run(normalized.name, normalized.repositoryPath, normalized.worktreeRoot, normalized.repository, normalized.baseBranch, normalized.targetBranch, normalized.setupCommand, normalized.verificationCommand, JSON.stringify(normalized.requiredChecks), JSON.stringify(normalized.roleDefaults), now, id);
      } else {
        db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?)").run(id, companyId, normalized.name, normalized.repositoryPath, normalized.worktreeRoot, normalized.repository, normalized.baseBranch, normalized.targetBranch, normalized.setupCommand, normalized.verificationCommand, JSON.stringify(normalized.requiredChecks), JSON.stringify(normalized.roleDefaults), now, now);
      }
      this.auth.recordAuditEventInTransaction(db, actorUserId, updating ? "project_updated" : "project_created", undefined, companyId, { projectId: id });
      return { id };
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
    if (status === "paused" && !project.activeRevisionId) throw new ProjectFailure("Project status change failed", [finding("project-inactive", "status", "Only a project with an accepted revision can be paused")], 409);
    this.database.authTransaction((db) => {
      db.prepare("UPDATE forge_projects SET status = ?, updated_at = ? WHERE id = ?").run(status, this.now().toISOString(), projectId);
      this.auth.recordAuditEventInTransaction(db, actorUserId, `project_${status}`, undefined, project.companyId, { projectId });
    });
    return this.getProject(actorUserId, projectId);
  }

  private rowForProject(db: import("better-sqlite3").Database, projectId: string): ProjectRow | undefined {
    return db.prepare(`SELECT ${projectRevisionColumns} FROM forge_projects p WHERE p.id = ?`).get(projectId) as ProjectRow | undefined;
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
