// Set SUPLEX_BROWSER_BACKEND=rust and SUPLEX_REAL_CODEX_ORIGIN to a disposable bare Git repository.
// The default run checks the form only. Set SUPLEX_REAL_CODEX_RUN=1 to execute one real task;
// SUPLEX_REAL_CODEX_MODEL selects an explicitly authorized test model. Set
// SUPLEX_DETERMINISTIC_CODEX_RUN=1 for the same journey with a test-only Codex process stand-in.
import { equal, notEqual, ok } from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativeBrowser } from "../helpers/native-browser.js";
import { runCommand } from "../../src/platform/command-runner.js";
import { TaskSchema } from "../../src/tasks/contracts.js";

const origin = process.env.SUPLEX_REAL_CODEX_ORIGIN;
if (!origin) throw new Error("Set SUPLEX_REAL_CODEX_ORIGIN to a disposable bare Git repository");
const model = process.env.SUPLEX_REAL_CODEX_MODEL ?? "gpt-6-sol";
const deterministic = process.env.SUPLEX_DETERMINISTIC_CODEX_RUN === "1";
if (deterministic && process.env.SUPLEX_REAL_CODEX_RUN === "1") throw new Error("Choose one Codex run mode");
if (deterministic) process.env.SUPLEX_CODEX_COMMAND = fileURLToPath(new URL("../fixtures/codex-standard-cli.mjs", import.meta.url));

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

const fixture = await nativeBrowser();
let preserveData = false;
try {
  const git = async (...args: string[]) => runCommand({ taskId: null, stepId: null, command: "git", args });
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
    const proof = resolve(deterministic ? ".context/deterministic-codex-standard" : ".context/real-codex-standard");
    await mkdir(proof, { recursive: true });
    await fixture.page.screenshot({ path: `${proof}/new-task.png`, fullPage: true });
    const createdResponse = fixture.page.waitForResponse(candidate => candidate.request().method() === "POST" && candidate.url().endsWith(`/api/companies/${fixture.company.id}/tasks`));
    await dialog.getByRole("button", { name: "New task", exact: true }).click();
    const created = await createdResponse;
    equal(created.status(), 201, await created.text());
    const task = TaskSchema.parse(await created.json());
    equal(task.status, "backlog");
    equal(task.deliveryTarget, "local_worktree");
    await fixture.page.getByRole("heading", { name: task.title, level: 2, exact: true }).waitFor();
    await fixture.page.screenshot({ path: `${proof}/created.png`, fullPage: true });
    const startResponse = fixture.page.waitForResponse(candidate => candidate.url().endsWith(`/api/tasks/${task.id}/start`));
    await fixture.page.getByRole("button", { name: "Start task", exact: true }).click();
    equal((await startResponse).status(), 200);
    await fixture.page.screenshot({ path: `${proof}/started.png`, fullPage: true });
    const deadline = Date.now() + 12 * 60_000;
    let delivered = task;
    while (Date.now() < deadline) {
      const current = await fixture.page.request.get(`${fixture.base}/api/tasks/${task.id}`).catch(() => {
        throw new Error(`Task ${task.id} status request failed; preserving fixture data`);
      });
      equal(current.status(), 200, await current.text());
      delivered = TaskSchema.parse(await current.json());
      if (delivered.status === "delivered") break;
      if (delivered.status === "waiting_human" || delivered.status === "cancelled") throw new Error(`Task ${task.id} entered ${delivered.status}; preserving fixture data`);
      await setTimeout(2_000);
    }
    equal(delivered.status, "delivered", `Task ${task.id} did not deliver before timeout`);
    const worktree = delivered.worktree?.path;
    ok(worktree, "Delivered task has a worktree path");
    const readme = await readFile(`${worktree}/README.md`, "utf8");
    ok(readme.includes("Verified by Suplex Standard task."));
    const head = (await git("-C", worktree, "rev-parse", "HEAD")).stdout.trim();
    notEqual(head, revision);
    await runCommand({ taskId: null, stepId: null, command: "pnpm", args: ["test"], cwd: worktree });
    const sessions = fixture.database.authQuery(db => db.prepare("SELECT id,kind,lifecycle,stopped_at AS stoppedAt,native_session_id AS nativeSessionId FROM suplex_task_sessions WHERE task_id = ? ORDER BY kind,id").all(task.id)) as Array<{ id: string; kind: string; lifecycle: string; stoppedAt: string | null; nativeSessionId: string | null }>;
    ok(sessions.some(session => session.kind === "root" && session.nativeSessionId));
    ok(sessions.some(session => session.kind === "worker" && session.nativeSessionId));
    // The host may stop delivered sessions on a later sweep. Wait before fixture deletion.
    const stopDeadline = Date.now() + 30_000;
    while (Date.now() < stopDeadline && sessions.some(session => !session.stoppedAt)) {
      await setTimeout(1_000);
      sessions.splice(0, sessions.length, ...fixture.database.authQuery(db => db.prepare("SELECT id,kind,lifecycle,stopped_at AS stoppedAt,native_session_id AS nativeSessionId FROM suplex_task_sessions WHERE task_id = ? ORDER BY kind,id").all(task.id)) as typeof sessions);
    }
    ok(sessions.every(session => session.stoppedAt), "Host has not confirmed native session stop; preserving fixture data");
    ok(await nativeGroupsAbsent(fixture.config.databasePath, sessions.map(session => session.id)), "A native process group is active or cannot be identified; preserving fixture data");
    await fixture.page.reload();
    await fixture.page.screenshot({ path: `${proof}/delivered.png`, fullPage: true });
    equal(fixture.errors.length, 0, fixture.errors.join("; "));
    console.log(JSON.stringify({ mode: deterministic ? "deterministic_process_mcp_ui" : "real_codex", taskId: task.id, status: delivered.status, head, sessions: sessions.map(({ kind, lifecycle }) => ({ kind, lifecycle })), proof }));
    preserveData = false;
  }
} finally {
  await fixture.close({ preserveData });
  if (preserveData) console.error(`Fixture data preserved for native recovery: ${fixture.directory}`);
}
