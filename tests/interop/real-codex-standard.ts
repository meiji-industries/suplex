// Set SUPLEX_REAL_CODEX_ORIGIN to a disposable bare Git repository.
// Deterministic runs create a seeded origin when SUPLEX_REAL_CODEX_ORIGIN is unset.
// The default run checks the form only. Set SUPLEX_REAL_CODEX_RUN=1 to execute one real task;
// SUPLEX_REAL_CODEX_MODEL selects an explicitly authorized test model. Set
// SUPLEX_DETERMINISTIC_CODEX_RUN=1 for the same journey with a test-only Codex process stand-in.
// The deterministic phase deliver_claude runs the deliver journey with Claude Code profiles and its stand-in.
import { deepStrictEqual, equal, notEqual, ok } from "node:assert/strict";
import { rmSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativeBrowser } from "../helpers/native-browser.js";
import { runCommand } from "../helpers/run-command.js";
import { TaskSchema } from "../../apps/web/contracts/tasks.js";

const journeyStartedAt = performance.now();
const model = process.env.SUPLEX_REAL_CODEX_MODEL ?? "gpt-6-sol";
const deterministic = process.env.SUPLEX_DETERMINISTIC_CODEX_RUN === "1";
if (deterministic && process.env.SUPLEX_REAL_CODEX_RUN === "1") throw new Error("Choose one Codex run mode");
if (deterministic) process.env.SUPLEX_CODEX_COMMAND = fileURLToPath(new URL("../fixtures/codex-standard-cli.mjs", import.meta.url));
const phase = deterministic ? process.env.SUPLEX_DETERMINISTIC_PHASE ?? "deliver" : "deliver";
// Workflow phases run one non-Standard workflow to local delivery; their Advisors use the stand-in's report bridge calls.
// refine_pull_request starts from pull request #1 on the seeded `feature` branch and delivers by push and merge.
const workflowNames: Record<string, string> = { direct_build: "Simple task", independent_review: "Double reviews", competing_plans: "Double plans", refine_pull_request: "Review and repair" };
const workflowPhase = phase in workflowNames;
const repair = phase === "refine_pull_request";
if (!["deliver", "deliver_pr", "answer", "restart", "cancel", "deliver_claude"].includes(phase) && !workflowPhase) throw new Error("Unknown deterministic phase");
const claude = phase === "deliver_claude";
const claudeConfig = claude ? await mkdtemp(join(tmpdir(), "suplex-claude-config-")) : null;
if (claudeConfig) {
  process.on("exit", () => rmSync(claudeConfig, { recursive: true, force: true }));
  process.env.SUPLEX_CLAUDE_COMMAND = fileURLToPath(new URL("../fixtures/claude-code-standard-cli.mjs", import.meta.url));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
}
const timeoutMs = Number(process.env.SUPLEX_JOURNEY_TIMEOUT_MS ?? 300_000);
let lastStep = "script started";
const progress = (step: string) => {
  lastStep = step;
  console.error(`[journey ${phase}] +${((performance.now() - journeyStartedAt) / 1_000).toFixed(2)}s ${step}`);
};
progress("setup started");
let closeOnTimeout: (() => Promise<void>) | undefined;
const journeyDeadline = globalThis.setTimeout(() => {
  console.error(`[journey ${phase}] timed out after ${timeoutMs} ms; last step: ${lastStep}`);
  void Promise.race([closeOnTimeout?.(), setTimeout(10_000)]).finally(() => process.exit(2));
}, timeoutMs);
const git = async (...args: string[]) => runCommand({ taskId: null, stepId: null, command: "git", args });
const seedDirectory = deterministic && !process.env.SUPLEX_REAL_CODEX_ORIGIN ? await mkdtemp(join(tmpdir(), "suplex-codex-origin-")) : null;
if (seedDirectory) {
  process.on("exit", () => rmSync(seedDirectory, { recursive: true, force: true }));
  const work = join(seedDirectory, "work");
  await git("init", "-b", "main", work);
  await writeFile(join(work, "README.md"), "# Seed\n");
  await writeFile(join(work, ".gitignore"), "node_modules/\npnpm-lock.yaml\n");
  await writeFile(join(work, "package.json"), `${JSON.stringify({ name: "seed", private: true, scripts: { test: "node -e \"process.exit(0)\"" } })}\n`);
  await git("-C", work, "add", ".");
  await git("-C", work, "-c", "user.name=Suplex fixture", "-c", "user.email=suplex-fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Seed");
  if (repair) {
    await git("-C", work, "checkout", "-b", "feature");
    await writeFile(join(work, "NOTES.md"), "Pull request under repair.\n");
    await git("-C", work, "add", "NOTES.md");
    await git("-C", work, "-c", "user.name=Suplex fixture", "-c", "user.email=suplex-fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Open the pull request");
    await git("-C", work, "checkout", "main");
  }
  await git("clone", "--bare", work, join(seedDirectory, "origin.git"));
}
const origin = seedDirectory ? join(seedDirectory, "origin.git") : process.env.SUPLEX_REAL_CODEX_ORIGIN;
if (!origin) throw new Error("Set SUPLEX_REAL_CODEX_ORIGIN to a disposable bare Git repository");
if (deterministic) {
  for (const file of ["README.md", "package.json"]) {
    const found = await runCommand({ taskId: null, stepId: null, command: "git", args: ["-C", origin, "cat-file", "-e", `HEAD:${file}`], expectNonZero: true });
    if (found.exitCode !== 0) throw new Error(`The deterministic Codex stand-in needs README.md and a package.json whose test script exits 0 at HEAD of ${origin}; ${file} is missing`);
  }
}
progress(`fixture ready: origin ${origin}`);
// deliver_pr and workflow phases: a loopback GitHub API that reads branch heads from the seeded origin and records pull requests.
const pulls: Array<{ number: number; repository: string; head: string; headSha: string; base: string; baseSha: string; title: string; body: string; draft: boolean; merged?: boolean }> = [];
const branchHead = async (branch: string) => {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args: ["--git-dir", origin, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], expectNonZero: true });
  return result.exitCode === 0 ? result.stdout.trim() : null;
};
let githubApi: Server | null = null;
if (phase === "deliver_pr" || workflowPhase) {
  // An open pull request follows its head branch; a merged one keeps the merged head.
  const refresh = async (pull: typeof pulls[number]) => {
    if (!pull.merged) pull.headSha = await branchHead(pull.head) ?? pull.headSha;
    return pull;
  };
  const rest = (pull: typeof pulls[number]) => {
    const side = (ref: string, sha: string) => ({ ref, sha, repo: { full_name: pull.repository } });
    return { number: pull.number, html_url: `https://github.com/${pull.repository}/pull/${pull.number}`, node_id: `PR_${pull.number}`, state: pull.merged ? "closed" : "open", draft: pull.draft, merged_at: pull.merged ? "2026-09-25T00:00:00Z" : null, auto_merge: null, head: side(pull.head, pull.headSha), base: side(pull.base, pull.baseSha), title: pull.title, body: pull.body, user: { login: "suplex" }, updated_at: "2026-09-25T00:00:00Z" };
  };
  githubApi = createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += String(chunk); });
    request.on("end", () => void (async () => {
      const send = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const body = raw ? JSON.parse(raw) as Record<string, any> : {};
      const branch = /^\/repos\/([^/]+\/[^/]+)\/branches\/(.+)$/.exec(url.pathname);
      if (request.method === "GET" && branch) {
        const sha = await branchHead(decodeURIComponent(branch[2]!));
        return sha ? send(200, { commit: { sha } }) : send(404, { message: "Branch not found" });
      }
      const create = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(url.pathname);
      if (request.method === "POST" && create) {
        const headSha = await branchHead(body.head);
        const baseSha = await branchHead(body.base);
        if (!headSha || !baseSha) return send(404, { message: "Not Found" });
        const pull = { number: pulls.length + 1, repository: create[1]!.toLowerCase(), head: body.head, headSha, base: body.base, baseSha, title: body.title, body: body.body, draft: body.draft === true };
        pulls.push(pull);
        return send(201, rest(pull));
      }
      const read = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(url.pathname);
      if (request.method === "GET" && read) {
        const pull = pulls[Number(read[2]) - 1];
        return pull ? send(200, rest(await refresh(pull))) : send(404, { message: "Not Found" });
      }
      if (request.method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) return send(200, { allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: false });
      // The exact-head merge: GitHub refuses a stale head and otherwise advances the base branch.
      const merge = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/.exec(url.pathname);
      if (request.method === "PUT" && merge) {
        const pull = pulls[Number(merge[2]) - 1];
        if (!pull || pull.merged) return send(405, { message: "Pull Request is not mergeable" });
        await refresh(pull);
        if (body.sha !== pull.headSha) return send(409, { message: "Head branch was modified. Review and try the merge again." });
        await runCommand({ taskId: null, stepId: null, command: "git", args: ["--git-dir", origin, "update-ref", `refs/heads/${pull.base}`, pull.headSha] });
        pull.merged = true;
        return send(200, { merged: true, message: "Pull Request successfully merged", sha: pull.headSha });
      }
      if (request.method === "POST" && url.pathname === "/graphql") {
        const query = String(body.query);
        const state = (pull: typeof pulls[number]) => pull.merged ? "MERGED" : "OPEN";
        if (query.includes("pullRequests(")) {
          const matching = pulls.filter(pull => body.variables?.head === undefined ? !pull.merged : pull.head === body.variables.head);
          for (const pull of matching) await refresh(pull);
          const nodes = matching.map(pull => ({ number: pull.number, url: `https://github.com/${pull.repository}/pull/${pull.number}`, isDraft: pull.draft, state: state(pull), headRefName: pull.head, headRefOid: pull.headSha, baseRefName: pull.base, baseRefOid: pull.baseSha, title: pull.title, body: pull.body, author: { login: "suplex" }, updatedAt: "2026-09-25T00:00:00Z", isCrossRepository: false }));
          return send(200, { data: { repository: { pullRequests: { nodes } } } });
        }
        const pull = pulls[Number(body.variables?.number) - 1];
        if (!pull) return send(200, { data: { repository: { pullRequest: null } } });
        await refresh(pull);
        return send(200, { data: { repository: { pullRequest: { number: pull.number, url: `https://github.com/${pull.repository}/pull/${pull.number}`, state: state(pull), isDraft: pull.draft, headRefOid: pull.headSha, baseRefOid: pull.baseSha, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", autoMergeRequest: null, reviewDecision: null, author: { login: "suplex", avatarUrl: "https://avatars.githubusercontent.com/suplex" }, changedFiles: 1, additions: 1, deletions: 0, title: pull.title, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } } } } });
      }
      send(404, { message: "Not Found" });
    })().catch(error => { response.writeHead(500); response.end(String(error)); }));
  });
  await new Promise<void>(accept => githubApi!.listen(0, "127.0.0.1", accept));
  const address = githubApi.address();
  if (!address || typeof address === "string") throw new Error("The loopback GitHub API did not bind");
  process.env.SUPLEX_TEST_GITHUB_API = `http://127.0.0.1:${address.port}`;
  progress(`loopback GitHub API on ${address.port}`);
}
const controlDirectory = deterministic && ["restart", "cancel"].includes(phase) ? await mkdtemp(join(tmpdir(), "suplex-codex-control-")) : null;
if (controlDirectory) {
  process.env.SUPLEX_DETERMINISTIC_PHASE = phase;
  process.env.SUPLEX_DETERMINISTIC_CONTROL_DIR = controlDirectory;
} else if (deterministic) process.env.SUPLEX_DETERMINISTIC_PHASE = phase;

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await access(path).then(() => true, () => false)) return;
    await setTimeout(100);
  }
  throw new Error("A deterministic native phase did not start");
}

async function nativeGroupsAbsent(databasePath: string, sessionIds: string[]): Promise<boolean> {
  for (const sessionId of sessionIds) {
    const directory = join(dirname(databasePath), "runtime", "task-sessions", sessionId);
    const records = (await readdir(directory)).filter(name => name === "turn.json" || /^dispatch-.*\.json$/.test(name));
    if (!records.length) return false;
    for (const name of records) {
      const record = JSON.parse(await readFile(join(directory, name), "utf8")) as { pid?: unknown; processIdentity?: { processGroup?: unknown } };
      if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0 || record.processIdentity?.processGroup !== record.pid) return false;
      try {
        process.kill(-record.pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
    }
  }
  return true;
}

const fixture = await nativeBrowser(1280, "127.0.0.1", undefined, { providerMode: "inherited" }).catch(async error => {
  if (controlDirectory) await rm(controlDirectory, { recursive: true, force: true });
  throw error;
});
closeOnTimeout = async () => {
  await fixture.close({ preserveData: true });
  console.error(`Fixture data preserved for native recovery: ${fixture.directory}`);
};
progress(`Rust listening on port ${fixture.config.port}`);
let preserveData = false;
try {
  await rm(fixture.project.repositoryPath, { recursive: true, force: true });
  await git("clone", origin, fixture.project.repositoryPath);
  const canonicalOrigin = `https://github.com/${fixture.project.repository}.git`;
  await git("-C", fixture.project.repositoryPath, "remote", "set-url", "origin", canonicalOrigin);
  await git("-C", fixture.project.repositoryPath, "config", "--local", `url.${pathToFileURL(origin).href}.insteadOf`, canonicalOrigin);
  const revision = (await git("-C", fixture.project.repositoryPath, "rev-parse", "HEAD")).stdout.trim();
  if (repair) {
    const [headSha, baseSha] = [await branchHead("feature"), await branchHead("main")];
    ok(headSha && baseSha, "The seeded origin has the pull request branches");
    pulls.push({ number: 1, repository: fixture.project.repository!.toLowerCase(), head: "feature", headSha, base: "main", baseSha, title: "Repair the README", body: "Add the verified README line.", draft: false });
  }
  for (const id of ["profile_native_root", "profile_native_independent", "profile_native_worker"]) {
    const provider = claude ? "claude-code" : "codex";
    const profileModel = claude ? "haiku" : model;
    fixture.database.prepare("UPDATE suplex_profiles SET provider = ?, model = ?, reasoning_level = 'medium', service_tier = 'default' WHERE id = ?").run(provider, profileModel, id);
    const profile = fixture.database.prepare("SELECT provider, model, reasoning_level AS reasoningLevel FROM suplex_profiles WHERE id = ?").get(id) as { provider: string; model: string; reasoningLevel: string };
    equal(profile.provider, provider);
    equal(profile.model, profileModel);
    equal(profile.reasoningLevel, "medium");
  }
  const response = await fixture.page.goto(`${fixture.base}/tasks?company=${fixture.company.id}`);
  equal(response?.status(), 200);
  await fixture.page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
  // Once the empty list loads, its empty state adds a second New task button; both open the same dialog.
  await fixture.page.getByRole("button", { name: "New task", exact: true }).first().click();
  const dialog = fixture.page.getByRole("dialog", { name: "New task", exact: true });
  await dialog.waitFor();
  await dialog.getByLabel("Task title", { exact: true }).fill("Append one verified README line");
  await dialog.getByLabel("Task description", { exact: true }).fill("Append `Verified by Suplex Standard task.` to README.md, run pnpm test, commit the change, and deliver the local worktree.");
  if (workflowPhase) {
    const workflowName = workflowNames[phase] ?? phase;
    await dialog.getByRole("button", { name: "Workflow", exact: true }).click();
    await fixture.page.getByRole("option", { name: workflowName }).click();
    await dialog.getByRole("button", { name: "Workflow", exact: true }).filter({ hasText: workflowName }).waitFor();
  }
  if (repair) {
    await dialog.getByRole("button", { name: "Pull request", exact: true }).click();
    await fixture.page.getByRole("menuitem").filter({ hasText: "#1 Repair the README" }).click();
    await dialog.getByRole("button", { name: "Pull request", exact: true }).filter({ hasText: "PR #1" }).waitFor();
  } else {
    await dialog.getByRole("button", { name: "Delivery target", exact: true }).click();
    await fixture.page.getByRole("option", { name: phase === "deliver_pr" ? "open a draft PR" : "keep in worktree" }).click();
  }
  equal(await dialog.getByRole("button", { name: "Task start mode", exact: true }).isEnabled(), true);
  equal(fixture.errors.length, 0, fixture.errors.join("; "));
  progress("setup complete");
  if (process.env.SUPLEX_REAL_CODEX_RUN !== "1" && !deterministic) {
    console.log(JSON.stringify({ backend: "rust", taskPage: response?.status(), dialog: "ready", project: fixture.project.id, revision }));
  } else {
    progress("execution started");
    preserveData = true;
    const proof = resolve(deterministic ? phase === "deliver" ? ".context/deterministic-codex-standard" : claude ? ".context/deterministic-claude-standard" : `.context/deterministic-codex-${phase}` : ".context/real-codex-standard");
    await mkdir(proof, { recursive: true });
    await fixture.page.screenshot({ path: `${proof}/new-task.png`, fullPage: true });
    const createdResponse = fixture.page.waitForResponse(candidate => candidate.request().method() === "POST" && candidate.url().endsWith(`/api/companies/${fixture.company.id}/tasks`));
    await dialog.getByRole("button", { name: "Task start mode", exact: true }).click();
    await fixture.page.getByRole("menuitemradio", { name: "Backlog", exact: true }).click();
    await dialog.getByRole("button", { name: "Create task", exact: true }).click();
    const created = await createdResponse;
    equal(created.status(), 201, await created.text());
    const task = TaskSchema.parse(await created.json());
    equal(task.status, "backlog");
    equal(task.deliveryTarget, phase === "deliver_pr" ? "pull_request_draft" : repair ? "merged" : "local_worktree");
    if (repair) equal(task.configuration.branch, "feature");
    if (workflowPhase) equal(task.workflow, phase);
    progress(`task created ${task.id}`);
    await fixture.page.getByRole("heading", { name: task.title, level: 2, exact: true }).waitFor();
    await fixture.page.screenshot({ path: `${proof}/created.png`, fullPage: true });
    const startResponse = fixture.page.waitForResponse(candidate => candidate.url().endsWith(`/api/tasks/${task.id}/start`));
    await fixture.page.getByRole("button", { name: "Start task", exact: true }).click();
    equal((await startResponse).status(), 200);
    progress("task started");
    await fixture.page.screenshot({ path: `${proof}/started.png`, fullPage: true });
    let pausedWorker: { sessionId: string; turnId: string; pid: number; startTime: string; dispatches: number } | null = null;
    if (phase === "answer") {
      progress("waiting for the Root question");
      let waiting = task;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await fixture.page.request.get(`${fixture.base}/api/tasks/${task.id}`);
        equal(response.status(), 200);
        waiting = TaskSchema.parse(await response.json());
        if (waiting.status === "waiting_human") break;
        await setTimeout(1_000);
      }
      equal(waiting.status, "waiting_human", "The Root did not ask its fixture question");
      await fixture.page.reload();
      const question = fixture.page.locator('[aria-label="Question"]');
      await question.waitFor();
      await question.locator('[data-slot="questionnaire-choice"]').filter({ hasText: "Proceed" }).click();
      const answerResponse = fixture.page.waitForResponse(candidate => candidate.url().endsWith(`/api/tasks/${task.id}/answer`));
      await question.getByRole("button", { name: "Answer and continue" }).click();
      equal((await answerResponse).status(), 200);
      progress("question answered");
      await fixture.page.screenshot({ path: `${proof}/answered.png`, fullPage: true });
    }
    if (controlDirectory) {
      progress("waiting for the paused Worker");
      await waitForFile(join(controlDirectory, "paused"));
      const snapshot = async () => {
        const row = fixture.database.prepare("SELECT s.id AS sessionId,t.id AS turnId FROM suplex_task_sessions s JOIN suplex_task_turns t ON t.session_id = s.id AND t.generation = s.generation WHERE s.task_id = ? AND s.kind = 'worker' AND s.is_current = 1 ORDER BY t.created_at DESC LIMIT 1").get(task.id) as { sessionId: string; turnId: string } | undefined;
        ok(row, "The paused Worker has a durable turn");
        const directory = join(dirname(fixture.config.databasePath), "runtime", "task-sessions", row.sessionId);
        // The fake Worker pauses before the host finishes writing turn.json.
        let record: { pid?: number; processIdentity?: { startTime?: string } } | undefined;
        for (let attempt = 0; !record && attempt < 100; attempt += 1) {
          record = await readFile(join(directory, "turn.json"), "utf8").then(JSON.parse).catch(() => undefined);
          if (!record) await setTimeout(100);
        }
        ok(record, "The paused Worker has a turn record");
        ok(record.pid && record.processIdentity?.startTime, "The paused Worker has a native process identity");
        const dispatches = (await readdir(directory)).filter(name => /^dispatch-.*\.json$/.test(name)).length;
        return { sessionId: row.sessionId, turnId: row.turnId, pid: record.pid!, startTime: record.processIdentity.startTime!, dispatches };
      };
      const before = await snapshot();
      process.kill(-before.pid!, 0);
      if (phase === "restart") {
        pausedWorker = before;
        progress("restarting Rust");
        await fixture.restartRust();
        const after = await snapshot();
        deepStrictEqual(after, before, "The backend restarted without replacing or replaying the admitted Worker");
        process.kill(-after.pid!, 0);
        await writeFile(join(controlDirectory, "release"), "continue\n");
        progress("Rust restarted; Worker released");
      }
      if (phase === "cancel") {
        await fixture.page.getByRole("button", { name: "Task options" }).click();
        const cancelResponse = fixture.page.waitForResponse(candidate => candidate.url().endsWith(`/api/tasks/${task.id}/cancel`));
        await fixture.page.getByRole("menuitem", { name: "Cancel task" }).click();
        equal((await cancelResponse).status(), 200);
        progress("cancel requested");
      }
    }
    const deadline = Date.now() + 12 * 60_000;
    let delivered = task;
    progress(`waiting for ${phase === "cancel" ? "cancelled" : "delivered"}`);
    while (Date.now() < deadline) {
      const current = await fixture.page.request.get(`${fixture.base}/api/tasks/${task.id}`).catch(() => {
        throw new Error(`Task ${task.id} status request failed; preserving fixture data`);
      });
      equal(current.status(), 200, await current.text());
      const previous = delivered.status;
      delivered = TaskSchema.parse(await current.json());
      if (delivered.status !== previous) progress(`task status ${delivered.status}`);
      if (delivered.status === (phase === "cancel" ? "cancelled" : "delivered")) break;
      if (delivered.status === "waiting_human" || (phase !== "cancel" && delivered.status === "cancelled")) throw new Error(`Task ${task.id} entered ${delivered.status}; preserving fixture data`);
      await setTimeout(2_000);
    }
    equal(delivered.status, phase === "cancel" ? "cancelled" : "delivered", `Task ${task.id} did not settle before timeout`);
    progress(`task ${delivered.status}`);
    const worktree = delivered.worktree?.path;
    ok(worktree, "The task has a worktree path");
    const readme = await readFile(`${worktree}/README.md`, "utf8");
    const head = (await git("-C", worktree, "rev-parse", "HEAD")).stdout.trim();
    if (phase === "cancel") {
      equal(readme.includes("Verified by Suplex Standard task."), false, "The paused Worker made no edit");
      equal(head, revision, "Cancellation left the original Git head intact");
    } else {
      ok(readme.includes("Verified by Suplex Standard task."));
      notEqual(head, revision);
      await runCommand({ taskId: null, stepId: null, command: "pnpm", args: ["test"], cwd: worktree });
    }
    if (phase === "deliver_pr") {
      equal(pulls.length, 1, "Suplex created one pull request");
      equal(pulls[0]!.draft, true);
      equal(pulls[0]!.headSha, head, "The pull request is at the reviewed worktree head");
      equal(pulls[0]!.title, "Append a verified README line");
      equal(pulls[0]!.head, delivered.configuration.branch);
      equal(delivered.pullRequest?.number, 1);
      progress("draft pull request created at the reviewed head");
    }
    const sessions = fixture.database.prepare("SELECT id,kind,lifecycle,stopped_at AS stoppedAt,native_session_id AS nativeSessionId FROM suplex_task_sessions WHERE task_id = ? ORDER BY kind,id").all(task.id) as Array<{ id: string; kind: string; lifecycle: string; stoppedAt: string | null; nativeSessionId: string | null }>;
    ok(sessions.some(session => session.kind === "root" && session.nativeSessionId));
    ok(sessions.some(session => session.kind === "worker" && session.nativeSessionId));
    if (workflowPhase) {
      const roles = fixture.database.prepare("SELECT advisor_role AS role FROM suplex_task_sessions WHERE task_id = ? AND advisor_role IS NOT NULL ORDER BY advisor_role").all(task.id) as Array<{ role: string }>;
      deepStrictEqual(roles.map(({ role }) => role), phase === "independent_review" ? ["reviewer"] : phase === "competing_plans" ? ["planner_a", "planner_b"] : repair ? ["rater"] : []);
      equal(delivered.workflowState.completion?.kind, "workflow");
      if (phase === "independent_review") equal(delivered.workflowState.reviews.at(-1)?.result?.role, "reviewer");
      if (repair) {
        // Pull request repair rates the pull request, repairs it, and rates the repaired head.
        deepStrictEqual(delivered.workflowState.reviews.map(review => review.result?.role === "rater" ? review.result.rating : null), [6, 9]);
        equal(pulls[0]!.merged, true, "Suplex merged the pull request");
        equal(pulls[0]!.headSha, head, "The merged pull request head is the rated worktree head");
        equal(await branchHead("feature"), head, "Suplex pushed the rated head");
        equal(delivered.pullRequest?.state, "merged");
        progress("pull request pushed and merged at the rated head");
      }
    }
    // The host may stop terminal sessions on a later sweep. Wait before fixture deletion.
    progress("waiting for native sessions to stop");
    const stopDeadline = Date.now() + 30_000;
    while (Date.now() < stopDeadline && sessions.some(session => !session.stoppedAt)) {
      await setTimeout(1_000);
      sessions.splice(0, sessions.length, ...fixture.database.prepare("SELECT id,kind,lifecycle,stopped_at AS stoppedAt,native_session_id AS nativeSessionId FROM suplex_task_sessions WHERE task_id = ? ORDER BY kind,id").all(task.id) as typeof sessions);
    }
    ok(sessions.every(session => session.stoppedAt), "Host has not confirmed native session stop; preserving fixture data");
    ok(await nativeGroupsAbsent(fixture.config.databasePath, sessions.map(session => session.id)), "A native process group is active or cannot be identified; preserving fixture data");
    if (phase === "restart") {
      ok(pausedWorker);
      const after = fixture.database.prepare("SELECT s.id AS sessionId,t.id AS turnId FROM suplex_task_sessions s JOIN suplex_task_turns t ON t.session_id = s.id AND t.generation = s.generation WHERE s.task_id = ? AND s.kind = 'worker' ORDER BY t.created_at DESC LIMIT 1").get(task.id) as { sessionId: string; turnId: string } | undefined;
      ok(after);
      const directory = join(dirname(fixture.config.databasePath), "runtime", "task-sessions", after.sessionId);
      const record = JSON.parse(await readFile(join(directory, "turn.json"), "utf8")) as { pid?: number; processIdentity?: { startTime?: string } };
      const dispatches = (await readdir(directory)).filter(name => /^dispatch-.*\.json$/.test(name)).length;
      deepStrictEqual({ ...after, pid: record.pid, startTime: record.processIdentity?.startTime, dispatches }, pausedWorker, "The settled Worker kept its original turn and native admission");
    }
    await fixture.page.reload();
    if (deterministic && phase !== "cancel") await fixture.page.locator('[aria-label="Conversation"]').getByText("README line committed after pnpm test passed.").waitFor({ timeout: 15_000 });
    await fixture.page.screenshot({ path: `${proof}/${phase === "cancel" ? "cancelled" : "delivered"}.png`, fullPage: true });
    equal(fixture.errors.length, 0, fixture.errors.join("; "));
    progress("execution complete");
    console.log(JSON.stringify({ mode: deterministic ? `deterministic_process_mcp_ui_${phase}` : "real_codex", taskId: task.id, status: delivered.status, head, sessions: sessions.map(({ kind, lifecycle }) => ({ kind, lifecycle })), proof }));
    preserveData = false;
  }
} finally {
  progress("cleanup started");
  globalThis.clearTimeout(journeyDeadline);
  githubApi?.close();
  await fixture.close({ preserveData });
  if (controlDirectory && !preserveData) await rm(controlDirectory, { recursive: true, force: true });
  if (preserveData) console.error(`Fixture data preserved for native recovery: ${fixture.directory}`);
  progress("cleanup complete");
}
