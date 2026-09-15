import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/platform/command-runner.js";
import { ForgeDatabase } from "../../src/platform/database.js";
import { DeliveryOperations, type DeliveryGithubPort } from "../../src/delivery/operations.js";
import { GithubReleaseFailure, type GithubPullRequest, type GithubPullRequestObservation, type LocalRevision } from "../../src/integrations/github/delivery.js";
import { RootController } from "../../src/coordination/root-controller.js";
import { TaskControlStore, type ProcessOwnerObservation } from "../../src/coordination/root-session-store.js";
import { prepareTaskWorktree } from "../../src/tasks/worktree.js";
import type { WorkflowId } from "../../src/coordination/workflows.js";
import { FakeTaskHarness } from "./fake-task-harness.js";
import { insertNativeTaskRow } from "./native-task-row.js";

const cleanups: Array<() => Promise<void>> = [];
/** Call from afterEach in every suite that uses the fixture. */
export async function cleanupDeliveryFixtures(): Promise<void> { for (const cleanup of cleanups.splice(0)) await cleanup(); }
export const git = async (cwd: string, args: string[]) => {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", cwd, args });
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
};
export const json = (value: unknown) => `Report prose with rationale and a surgical plan.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
export const rater = (rating: number, blockingFindings: string[] = [], verification = "passed") => json({ rating, blockingFindings, verification, verificationSummary: "pnpm test exit 0", summary: `Rated ${rating}` });
export const reviewer = (approved: boolean, blockingFindings: string[] = []) => json({ approved, blockingFindings, verification: "passed", verificationSummary: "pnpm test exit 0", summary: approved ? "Approved" : "Blocked" });
export const successful = { total: 1, pending: 0, failing: 0, successful: 1, runs: [{ name: "unit", status: "successful" as const, url: null, conclusion: "SUCCESS" }] };
export const pending = { total: 1, pending: 1, failing: 0, successful: 0, runs: [{ name: "unit", status: "pending" as const, url: null }] };
export const failing = { total: 1, pending: 0, failing: 1, successful: 0, runs: [{ name: "unit", status: "failing" as const, url: "https://ci.example/run/1", conclusion: "FAILURE" }] };

/** A local bare remote for actual Git behavior plus an injected GitHub adapter for pull request, check, and merge state. */
export async function fixture(workflow: WorkflowId, options: { deliveryTarget?: string; evidenceRoot?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "forge-workflow-delivery-"));
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }); });
  const bare = join(directory, "origin.git"); const repo = join(directory, "repo"); const worktrees = join(directory, "worktrees");
  await git(directory, ["init", "--bare", "-b", "main", bare]);
  await git(directory, ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]); await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["remote", "add", "origin", bare]);
  await writeFile(join(repo, "README.md"), "base\n"); await writeFile(join(repo, "src.ts"), "export const value = 1;\n");
  await git(repo, ["add", "."]); await git(repo, ["commit", "-m", "base"]); await git(repo, ["push", "origin", "main"]);
  const baseSha = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["checkout", "-b", "feature"]);
  await writeFile(join(repo, "src.ts"), "export const value = 2; // off by one\n");
  await git(repo, ["add", "."]); await git(repo, ["commit", "-m", "feature change"]); await git(repo, ["push", "origin", "feature"]);
  const featureSha = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["checkout", "main"]);
  const database = new ForgeDatabase(join(directory, "forge.sqlite"));
  cleanups.push(async () => database.close());
  const stamp = new Date().toISOString();
  database.authTransaction(db => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(stamp);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project', 'company', 'Project', ?, ?, 'owner/repo', 'main', '', 'pnpm test', ?, ?)").run(repo, worktrees, stamp, stamp);
    insertNativeTaskRow(db, { directory: repo });
    db.prepare("UPDATE forge_tasks SET configuration_json = json_set(configuration_json, '$.repositoryPath', ?, '$.worktreeRoot', ?, '$.branch', 'feature', '$.startingSha', ?, '$.baselineSha', ?, '$.verificationCommand', 'pnpm test') WHERE id = 'task'").run(repo, worktrees, featureSha, baseSha);
  });
  const worktree = await prepareTaskWorktree({ taskId: "task", repositoryPath: repo, worktreeRoot: worktrees, branch: "feature", startingSha: featureSha });
  await git(worktree.path, ["config", "user.email", "t@example.com"]); await git(worktree.path, ["config", "user.name", "T"]);
  const profile = { profileId: "profile_root", provider: "opencode", model: "openai/gpt-5.6-sol", reasoningLevel: "medium", serviceTier: "default" } as const;
  const advisorProfiles = workflow === "refine_pull_request" ? { rater: profile } : workflow === "independent_review" ? { reviewer: profile } : {};
  const alive = async (): Promise<ProcessOwnerObservation> => ({ kind: "running", startTime: "test-process" });
  const store = new TaskControlStore(database, alive);
  const deliveryTarget = options.deliveryTarget ?? (workflow === "refine_pull_request" ? "merged" : "pull_request_draft");
  store.create({ taskId: "task", startImmediately: true, objective: "Repair the feature pull request", deliveryTarget, deliveryIntent: { repository: "owner/repo", headBranch: "feature", baseBranch: "main", baselineSha: baseSha, pullRequestNumber: workflow === "refine_pull_request" ? 7 : null }, rootProfile: profile, workerProfile: { ...profile, profileId: "profile_worker" }, workflow, advisorProfiles, worktree });
  // GitHub adapter state; Git refs live in the bare remote.
  const github = { headSha: featureSha, baseSha, isDraft: true, state: "open" as GithubPullRequest["state"], checks: { total: 0, pending: 0, failing: 0, successful: 0, runs: [] as GithubPullRequestObservation["checks"]["runs"] }, mergeable: "MERGEABLE" as string | null, mergeStateStatus: "CLEAN" as string | null, reviewDecision: null as string | null, baseBranch: "main", repository: "owner/repo", remote: "owner/repo", onPush: (_head: string) => {}, onMerge: (_head: string) => "merge" as "merge" | "queue", crossRepository: false };
  const calls: string[] = [];
  const pull = (): GithubPullRequest => ({ number: 7, url: "https://github.com/owner/repo/pull/7", repository: github.repository, headBranch: "feature", baseBranch: github.baseBranch, headSha: github.headSha, baseSha: github.baseSha, isDraft: github.isDraft, state: github.state, mergedAt: github.state === "merged" ? stamp : null, isCrossRepository: github.crossRepository });
  const observation = (): GithubPullRequestObservation => ({ exists: true, number: 7, url: "https://github.com/owner/repo/pull/7", state: github.state, isDraft: github.isDraft, headSha: github.headSha, baseSha: github.baseSha, mergeable: github.mergeable, mergeStateStatus: github.mergeStateStatus, checks: github.checks, author: null, changedFiles: 1, additions: 1, deletions: 0, autoMergeEnabled: false, reviewDecision: github.reviewDecision });
  const revision = async (cwd: string): Promise<LocalRevision> => ({ branch: await git(cwd, ["branch", "--show-current"]), headSha: await git(cwd, ["rev-parse", "HEAD"]), treeSha: await git(cwd, ["rev-parse", "HEAD^{tree}"]), clean: (await git(cwd, ["status", "--porcelain"])) === "" });
  const port: DeliveryGithubPort = {
    getRemoteRepository: async () => github.remote,
    getBranchHead: async ({ branch }) => { calls.push(`head:${branch}`); const result = await runCommand({ taskId: null, stepId: null, command: "git", cwd: bare, args: ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], expectNonZero: true }); return result.exitCode === 0 ? result.stdout.trim() : null; },
    inspectLocalRevision: async ({ cwd }) => revision(cwd),
    pushNormal: async ({ cwd, branch, headSha }) => {
      calls.push(`push:${headSha}`);
      const result = await runCommand({ taskId: null, stepId: null, command: "git", cwd, args: ["push", "origin", `${headSha}:refs/heads/${branch}`], expectNonZero: true });
      if (result.exitCode !== 0) throw new GithubReleaseFailure("provider-unavailable", result.stderr.split("\n").find(line => line.includes("rejected")) ?? "normal push failed");
      github.headSha = headSha; github.onPush(headSha);
    },
    listPullRequests: async () => [pull()], createDraftPullRequest: async () => { calls.push("create"); return pull(); },
    getPullRequest: async () => { calls.push("get"); return pull(); },
    observePullRequest: async () => { calls.push("observe"); return observation(); },
    markReadyForReview: async () => { calls.push("ready"); github.isDraft = false; },
    mergePullRequest: async ({ headSha }) => {
      calls.push(`merge:${headSha}`);
      if (github.onMerge(headSha) === "queue") return;
      await git(bare, ["update-ref", "refs/heads/main", headSha]);
      github.state = "merged";
    },
  };
  const delivery = new DeliveryOperations(store, port);
  const harness = new FakeTaskHarness();
  const reader = () => ({
    turnEvidence: async () => ({ tools: [], limitation: null }),
    timeline: async () => ({ usage: [], liveMessageId: null }),
  });
  const controller = new RootController(store, harness, delivery, undefined, { root: options.evidenceRoot ?? join(directory, "evidence") }, reader);
  await controller.recover("task");
  harness.finish(harness.dispatched[0]!.messageID);
  const identity = () => { const current = store.currentSession("task", "root")!; return { taskId: "task", sessionId: current.id, generation: current.generation }; };
  /** The Coordinator ends its own turn after delegating, as its instructions require. */
  const endRootTurn = () => { for (const turn of store.pendingTurns(identity().sessionId)) if (turn.status === "prompted" && harness.observations.get(turn.id)?.state === "running") harness.finish(turn.id); };
  /** Ends every queued Coordinator wake, as a live Coordinator would consume them one turn at a time. */
  const drainRoot = async () => { for (let guard = 0; guard < 10 && store.pendingTurns(identity().sessionId).length; guard++) { endRootTurn(); await controller.recover("task"); } };
  const finishDelegate = async (text?: string, tools = true) => {
    endRootTurn();
    await controller.recover("task");
    const message = harness.dispatched.at(-1)!.messageID;
    if (tools && !text?.includes("```json")) harness.evidence.set(message, { tools: [{ id: `${message}:1`, name: "bash", status: "completed", input: { command: "pnpm test" }, output: "1 passed", error: null }], limit: null });
    harness.finish(message, "completed", text); await controller.recover("task");
  };
  const commit = async (name: string, content = `${name}\n`) => { await writeFile(join(worktree.path, name), content); await git(worktree.path, ["add", "."]); await git(worktree.path, ["commit", "-m", name]); return git(worktree.path, ["rev-parse", "HEAD"]); };
  const inspect = async () => { const diff = await controller.requestDelivery(identity(), "inspect_delivery_diff") as { baseSha: string; headSha: string; files: string[]; commits: string[] }; return { headSha: diff.headSha, review: { baseSha: diff.baseSha, headSha: diff.headSha, files: diff.files, commits: diff.commits } }; };
  const request = async (operation: Parameters<RootController["requestDelivery"]>[1]) => { const { headSha, review } = await inspect(); return controller.requestDelivery(identity(), operation, headSha, review); };
  const rootTurns = () => store.turns("task").filter(turn => turn.sessionId === identity().sessionId);
  return { directory, bare, repo, worktree, baseSha, featureSha, database, store, alive, harness, controller, delivery, port, github, calls, reader, identity, endRootTurn, drainRoot, finishDelegate, commit, inspect, request, rootTurns };
}
