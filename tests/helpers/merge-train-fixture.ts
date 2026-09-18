import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentDeliveryService } from "../../src/delivery/agent-delivery.js";
import { AuthService } from "../../src/identity/auth.js";
import { DeliveryOperations, type DeliveryGithubPort } from "../../src/delivery/operations.js";
import { ForgeDatabase } from "../../src/platform/database.js";
import { HermesAgentService } from "../../src/identity/hermes-agents.js";
import { ProjectService, type LocalRepositoryAdapter } from "../../src/projects/projects.js";
import { TaskService } from "../../src/tasks/tasks.js";
import { createTestConfig } from "../../src/platform/config.js";
import { prepareTaskWorktree } from "../../src/tasks/worktree.js";
import { runCommand } from "../../src/platform/command-runner.js";
import type { GithubAdapter } from "../../src/integrations/github/client.js";
import type { GithubPullRequest, GithubPullRequestObservation, LocalRevision } from "../../src/integrations/github/delivery.js";

const cleanups: Array<() => Promise<void>> = [];
/** Call from afterEach in every suite that uses the fixture. */
export async function cleanupMergeTrainFixtures(): Promise<void> { for (const cleanup of cleanups.splice(0)) await cleanup(); }

export const git = async (cwd: string, args: string[]): Promise<string> => {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", cwd, args });
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
};

export const successfulChecks = { total: 1, pending: 0, failing: 0, successful: 1, runs: [{ name: "unit", status: "successful" as const, url: null, conclusion: "SUCCESS" }] };
export const failingChecks = { total: 1, pending: 0, failing: 1, successful: 0, runs: [{ name: "unit", status: "failing" as const, url: "https://ci.example/run/1", conclusion: "FAILURE" }] };

/** The GitHub facts of one task's pull request. Git refs live in the bare remote; this is the provider's view. */
export interface TrainPull {
  number: number;
  branch: string;
  headSha: string;
  baseSha: string;
  isDraft: boolean;
  state: GithubPullRequest["state"];
  checks: GithubPullRequestObservation["checks"];
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
}

export interface TrainTask {
  id: string;
  branch: string;
  worktreePath: string;
  pull: TrainPull;
}

/**
 * A real bare remote that hosts several task branches, one paired agent, and one injected GitHub
 * adapter with per-pull-request state. Git decides every integration result; the adapter decides
 * only what GitHub reports.
 */
export async function mergeTrainFixture(count = 3) {
  const directory = await mkdtemp(join(tmpdir(), "forge-merge-train-"));
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }); });
  const bare = join(directory, "origin.git");
  const repo = join(directory, "repositories", "train");
  const worktrees = join(directory, "worktrees");
  await mkdir(join(directory, "repositories"), { recursive: true });
  await mkdir(worktrees, { recursive: true });
  await git(directory, ["init", "--bare", "-b", "main", bare]);
  await git(directory, ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await git(repo, ["remote", "add", "origin", bare]);
  await writeFile(join(repo, "README.md"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  await git(repo, ["push", "origin", "main"]);

  const database = new ForgeDatabase(join(directory, "forge.sqlite"));
  cleanups.push(async () => database.close());
  const config = createTestConfig(directory, { repositoryRoot: join(directory, "repositories"), worktreeRoot: worktrees, developmentAutoLogin: true });
  const auth = new AuthService(database, config);
  const adminId = auth.ensureDevelopmentUser().id;
  const localRepository: LocalRepositoryAdapter = {
    async inspect(input) {
      const head = await git(repo, ["rev-parse", "main"]);
      return { canonicalPath: input.repositoryPath, remoteRepository: "owner/repo", clean: true, baseSha: head, targetSha: head };
    },
  };
  const github: GithubAdapter = {
    async checkAuthentication() {},
    async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; },
  };
  const projects = new ProjectService(database, auth, config, { localRepository, github });
  const company = auth.createCompany(adminId, "Train Company");
  const project = await projects.createProject(adminId, company.id, {
    name: "Train Project", repositoryPath: repo, worktreeRoot: worktrees, repository: "owner/repo", baseBranch: "main",
    setupCommand: "pnpm install", verificationCommand: "pnpm test", rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker",
  });
  const tasks = new TaskService(database, auth, projects, config);
  const hermes = new HermesAgentService(database, auth);
  const issued = hermes.create(adminId, { name: "Train Agent", companyId: company.id, projectIds: [project.id] });
  const credential = hermes.exchange({ pairingCode: issued.pairingCode, profileId: "profile-train" }).credential;
  const principal = hermes.authenticate(credential);
  const store = tasks.repository.controls;

  const pulls = new Map<number, TrainPull>();
  const train: TrainTask[] = [];
  for (let index = 0; index < count; index++) {
    const created = await tasks.createTaskForHermes(principal, { projectId: project.id, title: `Train task ${index + 1}`, idempotencyKey: `train-task-${index + 1}`, images: [], advisorProfileIds: {} });
    const taskId = created.task.id;
    // The agent-managed train delivers merged pull requests, so an open pull request never completes the task.
    database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET delivery_target = 'merged' WHERE task_id = ?").run(taskId));
    store.start(taskId);
    const control = store.get(taskId);
    const worktree = await prepareTaskWorktree({ taskId, repositoryPath: repo, worktreeRoot: worktrees, branch: control.deliveryIntent.headBranch, startingSha: control.deliveryIntent.baselineSha });
    await git(worktree.path, ["config", "user.email", "t@example.com"]);
    await git(worktree.path, ["config", "user.name", "T"]);
    await git(worktree.path, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(worktree.path, `file-${index + 1}.txt`), `task ${index + 1}\n`);
    await git(worktree.path, ["add", "."]);
    await git(worktree.path, ["commit", "-m", `task ${index + 1}`]);
    const headSha = await git(worktree.path, ["rev-parse", "HEAD"]);
    await git(worktree.path, ["push", "origin", `HEAD:refs/heads/${control.deliveryIntent.headBranch}`]);
    store.setWorktree(taskId, { ...worktree, headSha, dirty: false });
    store.claimRoot({ taskId });
    const pull: TrainPull = {
      number: 100 + index, branch: control.deliveryIntent.headBranch, headSha, baseSha: await git(bare, ["rev-parse", "refs/heads/main"]),
      isDraft: false, state: "open", checks: successfulChecks, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED",
    };
    pulls.set(pull.number, pull);
    train.push({ id: taskId, branch: pull.branch, worktreePath: worktree.path, pull });
  }

  const find = (input: { number?: number | null; branch?: string }): TrainPull | undefined =>
    (input.number != null ? pulls.get(input.number) : undefined) ?? [...pulls.values()].find(pull => pull.branch === input.branch);
  const reference = (pull: TrainPull): GithubPullRequest => ({
    number: pull.number, url: `https://github.com/owner/repo/pull/${pull.number}`, repository: "owner/repo", headBranch: pull.branch,
    baseBranch: "main", headSha: pull.headSha, baseSha: pull.baseSha, isDraft: pull.isDraft, state: pull.state,
    mergedAt: pull.state === "merged" ? new Date().toISOString() : null, isCrossRepository: false,
  });
  const observationOf = (pull: TrainPull | undefined): GithubPullRequestObservation => pull
    ? { exists: true, number: pull.number, url: `https://github.com/owner/repo/pull/${pull.number}`, state: pull.state, isDraft: pull.isDraft, headSha: pull.headSha, baseSha: pull.baseSha, mergeable: pull.mergeable, mergeStateStatus: pull.mergeStateStatus, checks: pull.checks, author: null, changedFiles: 1, additions: 1, deletions: 0, autoMergeEnabled: false, reviewDecision: pull.reviewDecision }
    : { exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: null, mergeStateStatus: null, checks: { total: 0, pending: 0, failing: 0, successful: 0, runs: [] }, author: null, changedFiles: 0, additions: 0, deletions: 0, autoMergeEnabled: false, reviewDecision: null };
  const revision = async (cwd: string): Promise<LocalRevision> => ({
    branch: await git(cwd, ["branch", "--show-current"]), headSha: await git(cwd, ["rev-parse", "HEAD"]),
    treeSha: await git(cwd, ["rev-parse", "HEAD^{tree}"]), clean: (await git(cwd, ["status", "--porcelain"])) === "",
  });
  const merges: number[] = [];
  const port: DeliveryGithubPort = {
    getRemoteRepository: async () => "owner/repo",
    getBranchHead: async ({ branch }) => {
      const result = await runCommand({ taskId: null, stepId: null, command: "git", cwd: bare, args: ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], expectNonZero: true });
      return result.exitCode === 0 ? result.stdout.trim() : null;
    },
    inspectLocalRevision: async ({ cwd }) => revision(cwd),
    pushNormal: async ({ cwd, branch, headSha }) => { await git(cwd, ["push", "origin", `${headSha}:refs/heads/${branch}`]); },
    listPullRequests: async ({ headBranch }) => { const pull = find({ branch: headBranch }); return pull ? [reference(pull)] : []; },
    createDraftPullRequest: async ({ headBranch }) => reference(find({ branch: headBranch })!),
    getPullRequest: async ({ number }) => reference(pulls.get(number)!),
    observePullRequest: async input => observationOf(find({ number: input.pullRequestNumber ?? null, branch: input.branch })),
    markReadyForReview: async ({ number }) => { pulls.get(number)!.isDraft = false; },
    // A real merge in a disposable clone, so Git decides the integration result.
    mergePullRequest: async ({ number, headSha }) => {
      const pull = pulls.get(number)!;
      const clone = join(directory, `merge-${number}`);
      await git(directory, ["clone", "--quiet", bare, clone]);
      await git(clone, ["config", "user.email", "m@example.com"]);
      await git(clone, ["config", "user.name", "M"]);
      await git(clone, ["config", "commit.gpgsign", "false"]);
      await git(clone, ["merge", "--no-ff", "-q", "-m", `Merge #${number}`, headSha]);
      await git(clone, ["push", "-q", "origin", "main"]);
      pull.state = "merged";
      merges.push(number);
      for (const other of pulls.values()) if (other.state === "open") other.baseSha = await git(bare, ["rev-parse", "refs/heads/main"]);
    },
  };

  const delivery = new DeliveryOperations(store, port);
  /**
   * The Coordinator's own acceptance of the current head: it inspects the delivery range and publishes
   * it through Forge. Nothing else may write acceptedDelivery, so the agent can never merge an
   * unaccepted head.
   */
  const acceptHead = async (taskId: string): Promise<string> => {
    const root = store.currentSession(taskId, "root")!;
    const identity = { taskId, sessionId: root.id, generation: root.generation };
    const diff = await delivery.execute(identity, "inspect_delivery_diff") as { baseSha: string; headSha: string; files: string[]; commits: string[]; patchDigest?: string };
    await delivery.execute(identity, "push_branch", diff.headSha, { baseSha: diff.baseSha, headSha: diff.headSha, files: diff.files, commits: diff.commits, ...(diff.patchDigest ? { patchDigest: diff.patchDigest } : {}) });
    return diff.headSha;
  };
  for (const task of train) {
    await acceptHead(task.id);
    // Forge discovers and adopts each pull request from GitHub, exactly as the delivery workflow does.
    await delivery.observe(task.id);
  }
  const agentDelivery = new AgentDeliveryService({ database, tasks, store, delivery, auth });
  /** Replays a Coordinator repair turn: integrate the current base, push, accept the new head, and report it to GitHub. */
  const repairBranch = async (task: TrainTask): Promise<string> => {
    await git(task.worktreePath, ["fetch", "origin", "main"]);
    await git(task.worktreePath, ["merge", "--no-ff", "-q", "-m", "Integrate main", "FETCH_HEAD"]);
    const headSha = await git(task.worktreePath, ["rev-parse", "HEAD"]);
    await git(task.worktreePath, ["push", "origin", `HEAD:refs/heads/${task.branch}`]);
    store.setWorktree(task.id, { ...store.get(task.id).worktree!, headSha, dirty: false });
    task.pull.headSha = headSha;
    task.pull.baseSha = await git(bare, ["rev-parse", "refs/heads/main"]);
    task.pull.mergeable = "MERGEABLE";
    task.pull.mergeStateStatus = "CLEAN";
    await acceptHead(task.id);
    return headSha;
  };
  /** Pushes an extra commit that no Coordinator has accepted, as an out-of-band author would. */
  const pushUnacceptedCommit = async (task: TrainTask): Promise<string> => {
    await writeFile(join(task.worktreePath, "unaccepted.txt"), "out of band\n");
    await git(task.worktreePath, ["add", "."]);
    await git(task.worktreePath, ["commit", "-m", "out of band"]);
    const headSha = await git(task.worktreePath, ["rev-parse", "HEAD"]);
    await git(task.worktreePath, ["push", "origin", `HEAD:refs/heads/${task.branch}`]);
    task.pull.headSha = headSha;
    return headSha;
  };
  /** Issues an approval receipt and merges, exactly as a paired agent would. */
  const approveAndMerge = async (task: TrainTask) => {
    const approval = await agentDelivery.issueApproval(principal, task.id, { pullRequestNumber: task.pull.number, headSha: task.pull.headSha, baseSha: task.pull.baseSha });
    return agentDelivery.merge(principal, task.id, { pullRequestNumber: task.pull.number, expectedHeadSha: task.pull.headSha, expectedBaseSha: task.pull.baseSha, approvalReceipt: approval.receipt });
  };
  /** A human "Blocked by" edit, through the same dependency write path as the task view. */
  const blockOn = (task: TrainTask, blockers: TrainTask[]): void => {
    tasks.setTaskDependencies(adminId, task.id, blockers.map(blocker => blocker.id));
  };
  const dependOn = (task: TrainTask, dependencies: TrainTask[]): void => {
    tasks.setHermesTaskDependencies(principal, task.id, dependencies.map(dependency => dependency.id));
  };
  const auditCount = (action: string): number => database.authQuery(db => (db.prepare("SELECT COUNT(*) AS count FROM forge_audit_events WHERE action = ?").get(action) as { count: number }).count);
  const provenance = (taskId: string) => agentDelivery.provenance(principal, taskId);

  return { directory, bare, repo, worktrees, database, config, auth, adminId, company, project, projects, tasks, hermes, principal, credential, store, delivery, agentDelivery, port, pulls, train, merges, acceptHead, repairBranch, pushUnacceptedCommit, approveAndMerge, dependOn, blockOn, auditCount, provenance };
}
