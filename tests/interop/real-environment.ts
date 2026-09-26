// Real-environment verification of the Rust backend with real provider CLIs and the real GitHub account.
// It is not part of any default suite: it spends model tokens and, in the github phase, creates a real repository.
// Set SUPLEX_RUST_BIN, SUPLEX_RUST_ASSETS_DIR, and TMPDIR to an isolated directory.
// SUPLEX_REAL_PHASE=providers: for each provider in SUPLEX_REAL_PROVIDERS, create a Standard task in the UI,
//   restart Rust during the Worker turn, and cancel the task in the UI.
// SUPLEX_REAL_PHASE=github: create the private repository SUPLEX_REAL_GITHUB_NEW_REPOSITORY through the Rust
//   project-creation route and deliver one Standard task to pull_request_draft with SUPLEX_REAL_PROVIDERS[0].
//   With SUPLEX_REAL_GITHUB_REPOSITORY (owner/name) it adds that existing repository instead.
// SUPLEX_REAL_PHASE=signin: start GitHub device sign-in on the health page; wait SUPLEX_REAL_SIGNIN_WAIT_MS for the owner.
// Every phase checks the macOS unified log for SecurityAgent (the Keychain dialog process) during its window,
// searches the Rust output for Keychain prompts, and stops every process that names the fixture directory.
import { equal, ok } from "node:assert/strict";
import { rmSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { nativeBrowser } from "../helpers/native-browser.js";
import { runCommand } from "../helpers/run-command.js";
import { TaskSchema, type Task } from "../../src/frontend/contracts/tasks.js";

type Provider = "codex" | "claude-code" | "opencode" | "devin";
const phase = process.env.SUPLEX_REAL_PHASE ?? "providers";
if (!["providers", "github", "signin"].includes(phase)) throw new Error("Unknown real-environment phase");
const providers = (process.env.SUPLEX_REAL_PROVIDERS ?? "codex,claude-code,devin,opencode").split(",").filter(Boolean) as Provider[];
const defaultModels: Record<Provider, string> = { "codex": "gpt-5.6-luna", "claude-code": "haiku", "devin": "swe", "opencode": "opencode/big-pickle" };
const modelFor = (provider: Provider) => process.env[`SUPLEX_REAL_MODEL_${provider.replace("-", "_").toUpperCase()}`] ?? defaultModels[provider];
const proof = resolve(process.env.SUPLEX_REAL_PROOF_DIR ?? ".context/real-environment");
await mkdir(proof, { recursive: true });
const outputFile = process.env.SUPLEX_RUST_OUTPUT_FILE ?? join(proof, `rust-${phase}.log`);
process.env.SUPLEX_RUST_OUTPUT_FILE = outputFile;
await writeFile(outputFile, "");
const log = (message: string) => console.error(`[real ${phase}] ${new Date().toISOString()} ${message}`);
const git = async (...args: string[]) => runCommand({ taskId: null, stepId: null, command: "git", args });
const localTime = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().replace("T", " ").slice(0, 19);

/** SecurityAgent draws every Keychain password and approval dialog; securityd names the requesting process. */
async function keychainDialogs(start: Date, end: Date) {
  const result = await runCommand({ taskId: null, stepId: null, command: "/usr/bin/log", args: ["show", "--start", localTime(start), "--end", localTime(new Date(end.getTime() + 1_000)), "--style", "compact", "--predicate", "process == \"SecurityAgent\" OR (process == \"securityd\" AND eventMessage BEGINSWITH \"Keychain query for process\")"], expectNonZero: true });
  const lines = result.stdout.split("\n").filter(line => /SecurityAgent\[|Keychain query for process/.test(line));
  const deniedInRust = await runCommand({ taskId: null, stepId: null, command: "/usr/bin/log", args: ["show", "--start", localTime(start), "--end", localTime(new Date(end.getTime() + 1_000)), "--style", "compact", "--predicate", `process == "${basenameOf(process.env.SUPLEX_RUST_BIN ?? "suplex")}" AND category == "security_exception"`], expectNonZero: true });
  return { securityAgentLines: lines.length, securityAgentSample: lines.slice(0, 5), rustKeychainDenials: deniedInRust.stdout.split("\n").filter(line => line.includes("AUTH_DENIED")).length };
}
function basenameOf(path: string) { return path.split("/").at(-1)!; }

/** Processes whose arguments or environment name the fixture directory, other than this script. */
async function fixtureProcesses(directory: string) {
  const listed = await runCommand({ taskId: null, stepId: null, command: "ps", args: ["-Aww", "-E", "-o", "pid=,command="] });
  return listed.stdout.split("\n").filter(line => line.includes(directory)).map(line => ({ pid: Number(line.trim().split(/\s+/, 1)[0]), command: line.trim().split(/ [A-Z_]+=/, 1)[0]!.slice(0, 200) })).filter(({ pid }) => pid !== process.pid && pid > 1);
}
async function stopFixtureProcesses(directory: string) {
  const deadline = Date.now() + 30_000;
  let found = await fixtureProcesses(directory);
  while (found.length && Date.now() < deadline) {
    await setTimeout(1_000);
    found = await fixtureProcesses(directory);
  }
  const leftover = [...found];
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const { pid } of found) { try { process.kill(pid, signal); } catch { /* It exited. */ } }
    await setTimeout(2_000);
    found = await fixtureProcesses(directory);
  }
  return leftover;
}

async function seedOrigin() {
  const seed = await mkdtemp(join(tmpdir(), "suplex-real-origin-"));
  process.on("exit", () => rmSync(seed, { recursive: true, force: true }));
  const work = join(seed, "work");
  await git("init", "-b", "main", work);
  await writeFile(join(work, "README.md"), "# Seed\n");
  await writeFile(join(work, "package.json"), `${JSON.stringify({ name: "seed", private: true, scripts: { test: "node -e \"process.exit(0)\"" } })}\n`);
  await git("-C", work, "add", ".");
  await git("-C", work, "-c", "user.name=Suplex fixture", "-c", "user.email=suplex-fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Seed");
  await git("clone", "--bare", work, join(seed, "origin.git"));
  return join(seed, "origin.git");
}

const started = new Date();
const fixture = await nativeBrowser();
const results: Array<Record<string, unknown>> = [];
let failure: unknown;
const api = async (method: "GET" | "POST", path: string, data?: unknown) => {
  const response = method === "GET" ? await fixture.page.request.get(`${fixture.base}${path}`) : await fixture.page.request.post(`${fixture.base}${path}`, { data: data ?? {}, headers: { origin: fixture.base } });
  return { status: response.status(), body: await response.json().catch(async () => await response.text()) as any };
};
const readTask = async (id: string) => TaskSchema.parse((await api("GET", `/api/tasks/${id}`)).body);
const setProfiles = (provider: Provider) => {
  for (const id of ["profile_native_root", "profile_native_worker"]) {
    fixture.database.prepare("UPDATE suplex_profiles SET provider = ?, model = ?, reasoning_level = 'medium', service_tier = 'default' WHERE id = ?").run(provider, modelFor(provider), id);
    equal((fixture.database.prepare("SELECT provider FROM suplex_profiles WHERE id = ?").get(id) as { provider: string }).provider, provider);
  }
};
const workerTurn = (taskId: string) => fixture.database.prepare("SELECT s.id AS sessionId, s.native_session_id AS nativeSessionId, t.id AS turnId, t.status AS status, (SELECT count(*) FROM suplex_task_turns x WHERE x.session_id = s.id) AS turns FROM suplex_task_sessions s JOIN suplex_task_turns t ON t.session_id = s.id AND t.generation = s.generation WHERE s.task_id = ? AND s.kind = 'worker' AND s.is_current = 1 ORDER BY t.created_at DESC LIMIT 1").get(taskId) as { sessionId: string; nativeSessionId: string | null; turnId: string; status: string; turns: number } | undefined;
const sessionsOf = (taskId: string) => fixture.database.prepare("SELECT id, kind, lifecycle, stopped_at AS stoppedAt, native_session_id AS nativeSessionId FROM suplex_task_sessions WHERE task_id = ? ORDER BY kind, id").all(taskId) as Array<{ id: string; kind: string; lifecycle: string; stoppedAt: string | null; nativeSessionId: string | null }>;
async function turnProcess(sessionId: string) {
  const path = join(dirname(fixture.config.databasePath), "runtime", "task-sessions", sessionId, "turn.json");
  if (!await access(path).then(() => true, () => false)) return null;
  const record = JSON.parse(await readFile(path, "utf8")) as { pid?: number };
  if (!record.pid) return null;
  try { process.kill(-record.pid, 0); return { pid: record.pid, alive: true }; } catch { return { pid: record.pid, alive: false }; }
}
async function createTaskInUi(title: string, description: string): Promise<Task> {
  await fixture.page.goto(`${fixture.base}/tasks?company=${fixture.company.id}`);
  await fixture.page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
  await fixture.page.getByRole("button", { name: "New task", exact: true }).first().click();
  const dialog = fixture.page.getByRole("dialog", { name: "New task", exact: true });
  await dialog.waitFor();
  await dialog.getByLabel("Task title", { exact: true }).fill(title);
  await dialog.getByLabel("Task description", { exact: true }).fill(description);
  await dialog.getByRole("radio", { name: "Keep in worktree" }).check();
  await dialog.getByRole("checkbox", { name: "Start immediately", exact: true }).uncheck();
  const createdResponse = fixture.page.waitForResponse(candidate => candidate.request().method() === "POST" && candidate.url().endsWith(`/api/companies/${fixture.company.id}/tasks`));
  await dialog.getByRole("button", { name: "New task", exact: true }).click();
  const created = await createdResponse;
  equal(created.status(), 201, await created.text());
  const task = TaskSchema.parse(await created.json());
  await fixture.page.getByRole("heading", { name: task.title, level: 2, exact: true }).waitFor();
  const startResponse = fixture.page.waitForResponse(candidate => candidate.url().endsWith(`/api/tasks/${task.id}/start`));
  await fixture.page.getByRole("button", { name: "Start task", exact: true }).click();
  equal((await startResponse).status(), 200);
  return task;
}
async function waitForStatus(taskId: string, wanted: string[], limitMs: number) {
  const deadline = Date.now() + limitMs;
  let task = await readTask(taskId);
  let last = task.status;
  while (!wanted.includes(task.status) && Date.now() < deadline) {
    await setTimeout(2_000);
    task = await readTask(taskId);
    if (task.status !== last) log(`task status ${task.status}`);
    last = task.status;
    if (task.status === "waiting_human" && !wanted.includes("waiting_human") && !wanted.includes("cancelled")) break;
  }
  return task;
}
async function waitForStopped(taskId: string) {
  const deadline = Date.now() + 60_000;
  let sessions = sessionsOf(taskId);
  while (Date.now() < deadline && sessions.some(session => !session.stoppedAt)) {
    await setTimeout(1_000);
    sessions = sessionsOf(taskId);
  }
  return sessions;
}

try {
  log(`Rust on ${fixture.base}; installation ${fixture.directory}`);
  const health = await api("GET", "/api/health");
  const github = await api("GET", "/api/github/auth");
  const catalog = await api("GET", "/api/admin/providers");
  results.push({ step: "health", github: github.body, providers: (catalog.body.providers as Array<{ id: string; connection: { status: string; summary: string } }>).map(provider => ({ id: provider.id, connection: provider.connection.status, summary: provider.connection.summary })), ghCheck: (health.body.checks as Array<{ id: string }>).find(check => check.id === "gh-auth") });
  await fixture.page.goto(`${fixture.base}/health`);
  await fixture.page.waitForLoadState("networkidle");
  await fixture.page.screenshot({ path: `${proof}/${phase}-health.png`, fullPage: true });

  if (phase === "providers") {
    const origin = await seedOrigin();
    await git("clone", origin, fixture.project.repositoryPath);
    const canonicalOrigin = `https://github.com/${fixture.project.repository}.git`;
    await git("-C", fixture.project.repositoryPath, "remote", "set-url", "origin", canonicalOrigin);
    await git("-C", fixture.project.repositoryPath, "config", "--local", `url.${pathToFileURL(origin).href}.insteadOf`, canonicalOrigin);
    for (const provider of providers) {
      const runStarted = Date.now();
      const record: Record<string, unknown> = { step: "provider", provider, model: modelFor(provider) };
      results.push(record);
      try {
        setProfiles(provider);
        const task = await createTaskInUi(`Add a notes file with ${provider}`, "Create NOTES.md that lists five facts about the README of this repository, one per line. Then run pnpm test and commit the change. Take care: read README.md and package.json first.");
        record.taskId = task.id;
        log(`${provider}: task ${task.id} started`);
        await fixture.page.screenshot({ path: `${proof}/${provider}-started.png`, fullPage: true });
        const deadline = Date.now() + 10 * 60_000;
        let before = workerTurn(task.id);
        while (Date.now() < deadline && before?.status !== "prompted") {
          const current = await readTask(task.id);
          if (["waiting_human", "cancelled", "delivered", "failed"].includes(current.status)) {
            record.taskWhenStopped = (await api("GET", `/api/tasks/${task.id}`)).body;
            throw new Error(`${provider}: task entered ${current.status} before a Worker turn ran`);
          }
          await setTimeout(500);
          before = workerTurn(task.id);
        }
        ok(before?.status === "prompted", `${provider}: no Worker turn started`);
        const nativeBefore = await turnProcess(before.sessionId);
        record.workerTurnSeconds = Math.round((Date.now() - runStarted) / 1000);
        log(`${provider}: Worker turn ${before.turnId} prompted; restarting Rust`);
        await fixture.restartRust();
        const after = workerTurn(task.id);
        const nativeAfter = await turnProcess(before.sessionId);
        record.restart = { before, after, nativeBefore, nativeAfter };
        ok(after, `${provider}: the Worker turn disappeared after restart`);
        equal(after.sessionId, before.sessionId, `${provider}: restart replaced the Worker session`);
        equal(after.turnId, before.turnId, `${provider}: restart replaced the Worker turn`);
        equal(after.turns, before.turns, `${provider}: restart replayed the Worker prompt`);
        ok(["prompted", "completed"].includes(after.status), `${provider}: Worker turn is ${after.status} after restart`);
        if (nativeBefore?.alive) ok(nativeAfter?.alive || after.status === "completed", `${provider}: restart stopped the admitted native Worker`);
        await setTimeout(5_000);
        await fixture.page.reload();
        await fixture.page.getByRole("heading", { name: task.title, level: 2, exact: true }).waitFor();
        await fixture.page.screenshot({ path: `${proof}/${provider}-after-restart.png`, fullPage: true });
        const status = (await readTask(task.id)).status;
        record.statusBeforeCancel = status;
        if (!["cancelled", "delivered"].includes(status)) {
          await fixture.page.getByRole("button", { name: "Task options" }).click();
          const cancelResponse = fixture.page.waitForResponse(candidate => candidate.url().endsWith(`/api/tasks/${task.id}/cancel`));
          await fixture.page.getByRole("menuitem", { name: "Cancel task" }).click();
          equal((await cancelResponse).status(), 200);
          log(`${provider}: cancel requested`);
        }
        const settled = await waitForStatus(task.id, ["cancelled", "delivered"], 3 * 60_000);
        record.status = settled.status;
        equal(settled.status, "cancelled", `${provider}: task did not cancel`);
        const sessions = await waitForStopped(task.id);
        record.sessions = sessions.map(({ kind, lifecycle, stoppedAt, nativeSessionId }) => ({ kind, lifecycle, stopped: Boolean(stoppedAt), native: Boolean(nativeSessionId) }));
        ok(sessions.every(session => session.stoppedAt), `${provider}: a native session did not stop`);
        await fixture.page.reload();
        await fixture.page.getByRole("heading", { name: task.title, level: 2, exact: true }).waitFor();
        await fixture.page.screenshot({ path: `${proof}/${provider}-cancelled.png`, fullPage: true });
        record.result = "pass";
      } catch (error) {
        record.result = "fail";
        record.error = error instanceof Error ? error.message : String(error);
        log(record.error as string);
        failure ??= error;
        const taskId = record.taskId as string | undefined;
        // Diagnosis: keep the failed native state for inspection before cancelling.
        await setTimeout(Number(process.env.SUPLEX_REAL_PAUSE_ON_FAILURE_MS ?? 0));
        if (taskId) record.cancelStatus = (await api("POST", `/api/tasks/${taskId}/cancel`)).status;
        if (taskId) record.status = (await waitForStatus(taskId, ["cancelled"], 60_000)).status;
        if (taskId) record.sessions = (await waitForStopped(taskId)).map(({ kind, lifecycle, stoppedAt }) => ({ kind, lifecycle, stopped: Boolean(stoppedAt) }));
      }
      record.seconds = Math.round((Date.now() - runStarted) / 1000);
      log(JSON.stringify(record));
    }
  }

  if (phase === "github") {
    const runStarted = Date.now();
    const record: Record<string, unknown> = { step: "github" };
    results.push(record);
    const provider = providers[0]!;
    const repositoryName = process.env.SUPLEX_REAL_GITHUB_NEW_REPOSITORY;
    const existing = process.env.SUPLEX_REAL_GITHUB_REPOSITORY;
    ok(repositoryName || existing, "Set SUPLEX_REAL_GITHUB_NEW_REPOSITORY or SUPLEX_REAL_GITHUB_REPOSITORY");
    equal(github.body.status, "connected", "Rust has no GitHub credential");
    setProfiles(provider);
    const created = await api("POST", `/api/companies/${fixture.company.id}/projects`, existing ? { repositoryUrl: `https://github.com/${existing}`, baseBranch: "main" } : { repositoryName, baseBranch: "main" });
    record.projectCreate = { status: created.status, repository: created.body.repository, error: created.body.error, findings: created.body.findings };
    equal(created.status, 201, JSON.stringify(created.body));
    const project = created.body as { id: string; repository: string };
    record.repositoryUrl = `https://github.com/${project.repository}`;
    log(`created ${record.repositoryUrl}`);
    const task = await api("POST", `/api/companies/${fixture.company.id}/tasks`, { projectId: project.id, title: "Add a verification note", description: "Append the line `Verified by Suplex Rust.` to README.md and commit the change.", idempotencyKey: `w14-real-${Date.now()}`, deliveryTarget: "pull_request_draft", runProjectTests: false, startImmediately: true });
    equal(task.status, 201, JSON.stringify(task.body));
    record.taskId = task.body.id;
    await fixture.page.goto(`${fixture.base}/tasks/${task.body.id}?company=${fixture.company.id}`);
    const settled = await waitForStatus(task.body.id, ["delivered", "cancelled"], 15 * 60_000);
    record.status = settled.status;
    record.pullRequest = settled.pullRequest;
    await fixture.page.reload();
    await fixture.page.waitForLoadState("networkidle");
    await fixture.page.screenshot({ path: `${proof}/github-delivered.png`, fullPage: true });
    if (settled.status !== "delivered") {
      await api("POST", `/api/tasks/${task.body.id}/cancel`);
      await waitForStatus(task.body.id, ["cancelled"], 60_000);
    }
    equal(settled.status, "delivered", `Task ended ${settled.status}`);
    ok(settled.pullRequest?.number, "The task records a pull request");
    const sessions = await waitForStopped(task.body.id);
    ok(sessions.every(session => session.stoppedAt), "A native session did not stop");
    record.result = "pass";
    record.seconds = Math.round((Date.now() - runStarted) / 1000);
  }

  if (phase === "signin") {
    const record: Record<string, unknown> = { step: "signin" };
    results.push(record);
    await fixture.page.goto(`${fixture.base}/health`);
    await fixture.page.getByText("GitHub", { exact: true }).first().click();
    const button = fixture.page.getByRole("button", { name: "Sign in to GitHub" });
    await button.waitFor({ timeout: 15_000 });
    const startResponse = fixture.page.waitForResponse(candidate => candidate.url().endsWith("/api/github/device/start"));
    await button.click();
    const start = await startResponse;
    record.startStatus = start.status();
    const flow = await start.json() as { userCode: string; verificationUri: string; expiresAt: string };
    record.verificationUri = flow.verificationUri;
    record.codeShown = await fixture.page.getByText(flow.userCode, { exact: true }).isVisible();
    await fixture.page.screenshot({ path: `${proof}/signin-code.png`, fullPage: true });
    const firstPoll = await fixture.page.waitForResponse(candidate => candidate.url().endsWith("/api/github/device/poll"), { timeout: 30_000 });
    record.firstPoll = await firstPoll.json();
    const wait = Number(process.env.SUPLEX_REAL_SIGNIN_WAIT_MS ?? 0);
    if (wait > 0) {
      log(`Enter ${flow.userCode} at ${flow.verificationUri} within ${wait / 1000} s`);
      await fixture.page.getByText(/GitHub is connected as/).waitFor({ timeout: wait }).then(() => { record.connected = true; }, () => { record.connected = false; });
      await fixture.page.screenshot({ path: `${proof}/signin-final.png`, fullPage: true });
    }
    record.result = record.startStatus === 200 && record.codeShown ? "pass" : "fail";
  }
} catch (error) {
  failure ??= error;
} finally {
  await fixture.close().catch(error => { failure ??= error; });
  const leftover = await stopFixtureProcesses(fixture.directory);
  const ended = new Date();
  const rustOutput = await readFile(outputFile, "utf8").catch(() => "");
  const keychain = await keychainDialogs(started, ended);
  const summary = { phase, installation: fixture.directory, startedAt: started.toISOString(), endedAt: ended.toISOString(), seconds: Math.round((ended.getTime() - started.getTime()) / 1000), results, leftoverProcesses: leftover, keychain: { ...keychain, rustOutputMentions: rustOutput.split("\n").filter(line => /keychain|password|securityagent|interaction/i.test(line)) }, failure: failure ? String(failure instanceof Error ? failure.message : failure) : null };
  await writeFile(join(proof, `summary-${phase}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = failure || leftover.length ? 1 : 0;
}
