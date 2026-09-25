// Set SUPLEX_BROWSER_BACKEND=rust and SUPLEX_REAL_CODEX_ORIGIN to a disposable bare Git repository.
// Deterministic runs create a seeded origin when SUPLEX_REAL_CODEX_ORIGIN is unset.
// The default run checks the form only. Set SUPLEX_REAL_CODEX_RUN=1 to execute one real task;
// SUPLEX_REAL_CODEX_MODEL selects an explicitly authorized test model. Set
// SUPLEX_DETERMINISTIC_CODEX_RUN=1 for the same journey with a test-only Codex process stand-in.
import { deepStrictEqual, equal, notEqual, ok } from "node:assert/strict";
import { rmSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativeBrowser } from "../helpers/native-browser.js";
import { runCommand } from "../../src/platform/command-runner.js";
import { TaskSchema } from "../../src/tasks/contracts.js";

const model = process.env.SUPLEX_REAL_CODEX_MODEL ?? "gpt-6-sol";
const deterministic = process.env.SUPLEX_DETERMINISTIC_CODEX_RUN === "1";
if (deterministic && process.env.SUPLEX_REAL_CODEX_RUN === "1") throw new Error("Choose one Codex run mode");
if (deterministic) process.env.SUPLEX_CODEX_COMMAND = fileURLToPath(new URL("../fixtures/codex-standard-cli.mjs", import.meta.url));
const phase = deterministic ? process.env.SUPLEX_DETERMINISTIC_PHASE ?? "deliver" : "deliver";
if (!["deliver", "answer", "restart", "cancel"].includes(phase)) throw new Error("Unknown deterministic phase");
const timeoutMs = Number(process.env.SUPLEX_JOURNEY_TIMEOUT_MS ?? 300_000);
let lastStep = "script started";
const progress = (step: string) => {
  lastStep = step;
  console.error(`[journey ${phase}] ${step}`);
};
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
  await writeFile(join(work, "package.json"), `${JSON.stringify({ name: "seed", private: true, scripts: { test: "node -e \"process.exit(0)\"" } })}\n`);
  await git("-C", work, "add", ".");
  await git("-C", work, "-c", "user.name=Suplex fixture", "-c", "user.email=suplex-fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Seed");
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

const fixture = await nativeBrowser().catch(async error => {
  if (controlDirectory) await rm(controlDirectory, { recursive: true, force: true });
  throw error;
});
closeOnTimeout = async () => {
  await fixture.close({ preserveData: true });
  console.error(`Fixture data preserved for native recovery: ${fixture.directory}`);
};
progress(`${fixture.backend} listening on port ${fixture.config.port}`);
let preserveData = false;
try {
  await git("clone", origin, fixture.project.repositoryPath);
  const canonicalOrigin = `https://github.com/${fixture.project.repository}.git`;
  await git("-C", fixture.project.repositoryPath, "remote", "set-url", "origin", canonicalOrigin);
  await git("-C", fixture.project.repositoryPath, "config", "--local", `url.${pathToFileURL(origin).href}.insteadOf`, canonicalOrigin);
  const revision = (await git("-C", fixture.project.repositoryPath, "rev-parse", "HEAD")).stdout.trim();
  for (const id of ["profile_native_root", "profile_native_worker"]) {
    const profile = fixture.profiles.update(fixture.userId, id, { provider: "codex", model, reasoningLevel: "medium", serviceTier: "default" });
    equal(profile.provider, "codex");
    equal(profile.model, model);
    equal(profile.reasoningLevel, "medium");
  }
  const response = await fixture.page.goto(`${fixture.base}/tasks?company=${fixture.company.id}`);
  equal(response?.status(), 200);
  await fixture.page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
  await fixture.page.keyboard.press("c");
  const dialog = fixture.page.getByRole("dialog", { name: "New task", exact: true });
  await dialog.waitFor();
  await dialog.getByLabel("Task title", { exact: true }).fill("Append one verified README line");
  await dialog.getByLabel("Task description", { exact: true }).fill("Append `Verified by Suplex Standard task.` to README.md, run pnpm test, commit the change, and deliver the local worktree.");
  await dialog.getByRole("radio", { name: "Keep in worktree" }).check();
  await dialog.getByRole("checkbox", { name: "Start immediately", exact: true }).uncheck();
  equal(await dialog.getByRole("button", { name: "New task", exact: true }).isEnabled(), true);
  equal(fixture.errors.length, 0, fixture.errors.join("; "));
  if (process.env.SUPLEX_REAL_CODEX_RUN !== "1" && !deterministic) {
    console.log(JSON.stringify({ backend: fixture.backend, taskPage: response?.status(), dialog: "ready", project: fixture.project.id, revision }));
  } else {
    preserveData = true;
    const proof = resolve(deterministic ? phase === "deliver" ? ".context/deterministic-codex-standard" : `.context/deterministic-codex-${phase}` : ".context/real-codex-standard");
    await mkdir(proof, { recursive: true });
    await fixture.page.screenshot({ path: `${proof}/new-task.png`, fullPage: true });
    const createdResponse = fixture.page.waitForResponse(candidate => candidate.request().method() === "POST" && candidate.url().endsWith(`/api/companies/${fixture.company.id}/tasks`));
    await dialog.getByRole("button", { name: "New task", exact: true }).click();
    const created = await createdResponse;
    equal(created.status(), 201, await created.text());
    const task = TaskSchema.parse(await created.json());
    equal(task.status, "backlog");
    equal(task.deliveryTarget, "local_worktree");
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
        const row = fixture.database.authQuery(db => db.prepare("SELECT s.id AS sessionId,t.id AS turnId FROM suplex_task_sessions s JOIN suplex_task_turns t ON t.session_id = s.id AND t.generation = s.generation WHERE s.task_id = ? AND s.kind = 'worker' AND s.is_current = 1 ORDER BY t.created_at DESC LIMIT 1").get(task.id)) as { sessionId: string; turnId: string } | undefined;
        ok(row, "The paused Worker has a durable turn");
        const directory = join(dirname(fixture.config.databasePath), "runtime", "task-sessions", row.sessionId);
        const record = JSON.parse(await readFile(join(directory, "turn.json"), "utf8")) as { pid?: number; processIdentity?: { startTime?: string } };
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
    const sessions = fixture.database.authQuery(db => db.prepare("SELECT id,kind,lifecycle,stopped_at AS stoppedAt,native_session_id AS nativeSessionId FROM suplex_task_sessions WHERE task_id = ? ORDER BY kind,id").all(task.id)) as Array<{ id: string; kind: string; lifecycle: string; stoppedAt: string | null; nativeSessionId: string | null }>;
    ok(sessions.some(session => session.kind === "root" && session.nativeSessionId));
    ok(sessions.some(session => session.kind === "worker" && session.nativeSessionId));
    // The host may stop terminal sessions on a later sweep. Wait before fixture deletion.
    progress("waiting for native sessions to stop");
    const stopDeadline = Date.now() + 30_000;
    while (Date.now() < stopDeadline && sessions.some(session => !session.stoppedAt)) {
      await setTimeout(1_000);
      sessions.splice(0, sessions.length, ...fixture.database.authQuery(db => db.prepare("SELECT id,kind,lifecycle,stopped_at AS stoppedAt,native_session_id AS nativeSessionId FROM suplex_task_sessions WHERE task_id = ? ORDER BY kind,id").all(task.id)) as typeof sessions);
    }
    ok(sessions.every(session => session.stoppedAt), "Host has not confirmed native session stop; preserving fixture data");
    ok(await nativeGroupsAbsent(fixture.config.databasePath, sessions.map(session => session.id)), "A native process group is active or cannot be identified; preserving fixture data");
    if (phase === "restart") {
      ok(pausedWorker);
      const after = fixture.database.authQuery(db => db.prepare("SELECT s.id AS sessionId,t.id AS turnId FROM suplex_task_sessions s JOIN suplex_task_turns t ON t.session_id = s.id AND t.generation = s.generation WHERE s.task_id = ? AND s.kind = 'worker' ORDER BY t.created_at DESC LIMIT 1").get(task.id)) as { sessionId: string; turnId: string } | undefined;
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
    progress("done");
    console.log(JSON.stringify({ mode: deterministic ? `deterministic_process_mcp_ui_${phase}` : "real_codex", taskId: task.id, status: delivered.status, head, sessions: sessions.map(({ kind, lifecycle }) => ({ kind, lifecycle })), proof }));
    preserveData = false;
  }
} finally {
  globalThis.clearTimeout(journeyDeadline);
  await fixture.close({ preserveData });
  if (controlDirectory && !preserveData) await rm(controlDirectory, { recursive: true, force: true });
  if (preserveData) console.error(`Fixture data preserved for native recovery: ${fixture.directory}`);
}
