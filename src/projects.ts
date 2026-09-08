import { randomBytes } from "node:crypto";
import { access, constants, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
// eslint-disable-next-line no-restricted-imports -- this module owns the legacy local repository adapter.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Database } from "better-sqlite3";

import type { AuthUser } from "./auth.js";
import { AuthFailure, type AuthService } from "./auth.js";
import type { ForgeConfig } from "./config.js";
import { GithubFailure, createGithubAdapter, type GithubAdapter } from "./github.js";
import type { ForgeDatabase } from "./database.js";
import { createGithubReleasePort, type GithubReleasePort } from "./github-delivery.js";
import { TaskSourceService, type TaskSourceSelector } from "./task-sources.js";
import { readProviders as readHostProviders, type ReadProviders } from "./provider-catalog.js";

const execFileAsync = promisify(execFile);

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

export interface OpenCodeModelOption {
  id: string;
  provider: string;
  providerLabel: string;
  displayName: string;
}

export interface ProjectInput {
  name: string;
  repositoryPath: string;
  worktreeRoot: string;
  repository: string;
  baseBranch: string;
  setupCommand: string;
  verificationCommand: string;
  rootProfileId: string;
  workerProfileId: string;
}

export interface Project {
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

export interface GithubRepositoryCoordinate {
  cloneUrl: string;
  repository: string;
  name: string;
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
  created_at: string;
  updated_at: string;
}

const projectColumns = "p.*";

const namePattern = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._'-]{0,78}[\p{L}\p{N}])?$/u;
const repositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;
const branchPattern = /^(?![./])(?!.*(?:\.\.|\.$|\.lock$|\/\/|\s|[~^:?*\[\\]))[A-Za-z0-9._/-]+$/;
const secretPattern = /(?:gh[pousr]_|github_pat_|token\s*=|password\s*=|secret\s*=|BEGIN [A-Z ]+ PRIVATE KEY|sk-[A-Za-z0-9])/i;

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

function normalizedInput(input: ProjectInput, paths: { repositoryPath: string; worktreeRoot: string }): ProjectInput {
  const normalized: ProjectInput = {
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
  return {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function finding(code: string, field: string, message: string): ProjectFinding {
  return { code, field, message };
}

function isUsableCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed.length > 0 && trimmed.length <= 500 && !/[\r\n]/.test(command) && !secretPattern.test(command);
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
  const run = async (args: string[], cwd: string, timeout = 8_000): Promise<string> => {
    try {
      const result = await execFileAsync("git", args, { cwd, timeout, maxBuffer: 16 * 1024 });
      return result.stdout.trim();
    } catch {
      throw new ProjectFailure("Repository validation failed", [finding("repository-unavailable", "repositoryPath", "Git could not inspect the configured repository")], 422);
    }
  };
  return {
    async inspect(input) {
      const canonicalPath = await run(["rev-parse", "--show-toplevel"], input.repositoryPath);
      const status = await run(["status", "--porcelain", "--untracked-files=all"], input.repositoryPath);
      const remoteUrl = await run(["config", "--get", "remote.origin.url"], input.repositoryPath);
      if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(remoteUrl) || /(?:token|password|secret)=/i.test(remoteUrl)) {
        throw new ProjectFailure("Repository validation failed", [finding("credential-url", "repository", "Credential-bearing repository URLs are not accepted")], 422);
      }
      const remote = githubRepositoryFromRemote(remoteUrl);
      if (!remote || remote.credentialBearing) {
        throw new ProjectFailure("Repository validation failed", [finding("repository-identity", "repository", "Origin must identify a canonical GitHub repository")], 422);
      }
      await run(["fetch", "--no-tags", "origin", `refs/heads/${input.baseBranch}:refs/remotes/origin/${input.baseBranch}`], input.repositoryPath, 30_000);
      const baseSha = await run(["rev-parse", "--verify", `refs/remotes/origin/${input.baseBranch}`], input.repositoryPath);
      return { canonicalPath, remoteRepository: remote.identity, clean: status.length === 0, baseSha };
    },
  };
}

export class ProjectService {
  private readonly now: () => Date;
  private readonly github: GithubAdapter;
  private readonly localRepository: LocalRepositoryAdapter | undefined;
  private readonly repositoryProvisioner: RepositoryProvisioner;
  private readonly validateProjectConfiguration: boolean;
  private readonly taskSources: TaskSourceService;
  private readonly readProviders: ReadProviders;

  constructor(
    private readonly database: ForgeDatabase,
    private readonly auth: AuthService,
    private readonly config: ForgeConfig,
    options: ProjectServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.github = options.github ?? createGithubAdapter();
    this.localRepository = options.localRepository;
    this.repositoryProvisioner = options.repositoryProvisioner ?? defaultRepositoryProvisioner();
    // Unit fixtures do not represent a local checkout or a provider session.
    // They opt out without performing network work; production keeps the
    // save-time guard unless an explicit test fake supplies a value.
    this.validateProjectConfiguration = options.validateProjectConfiguration ?? process.env.VITEST === undefined;
    this.taskSources = new TaskSourceService(options.githubRelease ?? createGithubReleasePort());
    this.readProviders = options.readProviders ?? (() => readHostProviders({ directory: process.cwd() }));
  }

  async listModels(actorUserId: string): Promise<OpenCodeModelOption[]> {
    this.user(actorUserId);
    const native = await this.readProviders();
    return native.providers.flatMap((provider) => provider.models.map((model) => ({ id: model.id, provider: provider.id, providerLabel: provider.label, displayName: model.label })));
  }

  async getProjectRepositoryDefaults(actorUserId: string, projectId: string): Promise<{ setupCommand: string; verificationCommand: string }> {
    const project = this.getProject(actorUserId, projectId);
    return inferRepositoryCommands(project.repositoryPath);
  }

  createProject(actorUserId: string, companyId: string, input: ProjectInput): Promise<Project> {
    return this.mutateProject(actorUserId, companyId, input, false);
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
    const draft = await this.mutateProject(actorUserId, companyId, {
      name: coordinate.name,
      repositoryPath,
      worktreeRoot,
      repository: coordinate.repository,
      baseBranch: "main",
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

  /** Resolve the runtime values that a newly-created task owns thereafter. */
  async captureTaskConfiguration(project: Project): Promise<{ baseSha: string }> {
    try {
      const inspection = await (this.localRepository ?? await defaultLocalRepositoryAdapter()).inspect({ repositoryPath: project.repositoryPath, baseBranch: project.baseBranch });
      if (!inspection.baseSha) throw new Error("branch unavailable");
      return { baseSha: inspection.baseSha };
    } catch {
      throw new ProjectFailure("Project configuration could not be captured", [finding("repository-unavailable", "projectId", "Forge could not resolve the configured branches for this new task")], 422);
    }
  }

  async discoverTaskSources(actorUserId: string, projectId: string, kind: TaskSourceSelector["kind"]): Promise<Awaited<ReturnType<TaskSourceService["discover"]>>> {
    return this.taskSources.discover(this.getProject(actorUserId, projectId), kind);
  }

  async resolveTaskSource(project: Project, selector: TaskSourceSelector): Promise<Awaited<ReturnType<TaskSourceService["resolve"]>>> {
    return this.taskSources.resolve(project, selector);
  }

  getProject(actorUserId: string, projectId: string): Project {
    const row = this.database.authQuery((db) => {
      const user = this.user(actorUserId);
      const result = user.role === "admin"
        ? db.prepare(`SELECT ${projectColumns} FROM forge_projects p WHERE p.id = ?`).get(projectId)
        : db.prepare(`SELECT ${projectColumns} FROM forge_projects p JOIN forge_memberships m ON m.company_id = p.company_id WHERE p.id = ? AND m.user_id = ?`).get(projectId, actorUserId);
      return result as ProjectRow | undefined;
    });
    if (!row) throw new ProjectFailure("Not found", [], 404);
    return publicProject(row);
  }

  getProjectInCompany(companyId: string, projectId: string): Project {
    const row = this.database.authQuery(db => db.prepare(`SELECT ${projectColumns} FROM forge_projects p WHERE p.id = ? AND p.company_id = ?`).get(projectId, companyId) as ProjectRow | undefined);
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
        ? companyId ? db.prepare(`SELECT ${projectColumns} FROM forge_projects p WHERE p.company_id = ? ORDER BY p.name`) : db.prepare(`SELECT ${projectColumns} FROM forge_projects p ORDER BY p.name`)
        : companyId ? db.prepare(`SELECT ${projectColumns} FROM forge_projects p JOIN forge_memberships m ON m.company_id = p.company_id WHERE m.user_id = ? AND p.company_id = ? ORDER BY p.name`) : db.prepare(`SELECT ${projectColumns} FROM forge_projects p JOIN forge_memberships m ON m.company_id = p.company_id WHERE m.user_id = ? ORDER BY p.name`);
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
    if (!isUsableCommand(input.setupCommand)) findings.push(finding("unapproved-command", "setupCommand", "Command must be a single non-empty line without secrets"));
    if (!isUsableCommand(input.verificationCommand)) findings.push(finding("unapproved-command", "verificationCommand", "Command must be a single non-empty line without secrets"));
    if (secretPattern.test(input.repository) || secretPattern.test(input.baseBranch)) findings.push(finding("secret-shaped-value", "configuration", "Secret-shaped configuration values are not accepted"));
    if (worktree.path) {
      try { await access(worktree.path, constants.W_OK); } catch { findings.push(finding("worktree-unwritable", "worktreeRoot", "Worktree root must be writable")); }
    }
    const normalized = normalizedInput(input, { repositoryPath: repository.path ?? resolve(input.repositoryPath), worktreeRoot: worktree.path ?? resolve(input.worktreeRoot) });
    if (this.validateProjectConfiguration && findings.length === 0) {
      try {
        const inspection = await (this.localRepository ?? await defaultLocalRepositoryAdapter()).inspect({ repositoryPath: normalized.repositoryPath, baseBranch: normalized.baseBranch });
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
        await this.github.checkAuthentication();
        const remote = await this.github.getRepository({ cwd: normalized.repositoryPath, nameWithOwner: normalized.repository });
        if (remote.nameWithOwner.toLowerCase() !== normalized.repository.toLowerCase()) findings.push(finding("provider-mismatch", "repository", "GitHub repository identity does not match configuration"));
        let providerUrl: URL | undefined;
        try { providerUrl = new URL(remote.url); } catch {}
        if (!providerUrl || providerUrl.protocol !== "https:" || providerUrl.hostname.toLowerCase() !== "github.com") findings.push(finding("provider-host", "repository", "GitHub provider returned a URL outside github.com"));
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
        if (!db.prepare("SELECT 1 FROM forge_profiles WHERE id = ? AND role = ? AND archived_at IS NULL").get(profileId, role)) {
          throw new ProjectFailure("Project configuration is invalid", [finding("profile-ineligible", `${role}ProfileId`, "Select an active profile with the matching role")], 422);
        }
      }
      const id = projectId ?? identifier("project");
      if (updating) {
        const existing = this.rowForProject(db, id);
        if (!existing || existing.company_id !== companyId) throw new ProjectFailure("Not found", [], 404);
        db.prepare("UPDATE forge_projects SET name = ?, repository_path = ?, worktree_root = ?, repository_identity = ?, base_branch = ?, setup_command = ?, verification_command = ?, root_profile_id = ?, worker_profile_id = ?, updated_at = ? WHERE id = ?").run(normalized.name, normalized.repositoryPath, normalized.worktreeRoot, normalized.repository, normalized.baseBranch, normalized.setupCommand, normalized.verificationCommand, normalized.rootProfileId, normalized.workerProfileId, now, id);
      } else {
        db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, companyId, normalized.name, normalized.repositoryPath, normalized.worktreeRoot, normalized.repository, normalized.baseBranch, normalized.setupCommand, normalized.verificationCommand, normalized.rootProfileId, normalized.workerProfileId, now, now);
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

  private rowForProject(db: Database, projectId: string): ProjectRow | undefined {
    return db.prepare(`SELECT ${projectColumns} FROM forge_projects p WHERE p.id = ?`).get(projectId) as ProjectRow | undefined;
  }

  private user(userId: string): AuthUser {
    const user = this.auth.getUserForAuthority(userId);
    if (!user) throw new AuthFailure("Authentication required", 401);
    return user;
  }

}
