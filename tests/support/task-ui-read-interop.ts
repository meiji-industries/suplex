import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { taskSessionRuntimeDirectory } from "../../src/runtimes/task-harness.js";
import { nativeApp } from "../helpers/native-app.js";

const fixture = await nativeApp();
try {
  fixture.profiles.update(fixture.userId, fixture.project.rootProfileId, { provider: "codex" });
  const { task } = await fixture.tasks.createTask(fixture.userId, fixture.company.id, {
    projectId: fixture.project.id,
    title: "Read native task activity",
    description: "Compare complete task detail responses",
    idempotencyKey: "task-ui-read-interop",
    startImmediately: true,
  });
  const reserved = fixture.tasks.repository.controls.claimRoot({ taskId: task.id });
  fixture.tasks.repository.controls.bindHarnessSession({
    sessionId: reserved.id,
    generation: reserved.generation,
    nativeSessionId: "codex-ui-read",
  });
  const stamp = "2026-09-25T12:00:00.000Z";
  fixture.database.authTransaction(db => {
    db.prepare("INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,prompted_at,completed_at,created_at,updated_at) VALUES ('msg_ui_read',?,?,?,'hash','Inspect the worktree','completed',?,?,?,?)")
      .run(task.id, reserved.id, reserved.generation, stamp, stamp, stamp, stamp);
  });
  const runtime = taskSessionRuntimeDirectory(fixture.config.databasePath, reserved.id);
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, "turn-msg_ui_read.jsonl"), [
    '{"type":"thread.started","thread_id":"ui-read-thread"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"pnpm test","aggregated_output":"2 passed","exit_code":0,"status":"completed"}}',
    '{"type":"turn.completed"}',
    "",
  ].join("\n"));
  const paths = ["activity", "execution", "diff/summary"] as const;
  const responses = await Promise.all(paths.map(async path => {
    const response = await fixture.app.inject({ url: `/api/tasks/${task.id}/${path}`, headers: fixture.headers });
    return { path, status: response.statusCode, body: JSON.parse(response.body) as unknown, cacheControl: response.headers["cache-control"] ?? null };
  }));
  process.stdout.write(JSON.stringify({
    databasePath: fixture.config.databasePath,
    taskId: task.id,
    cookie: fixture.headers.cookie,
    responses,
  }) + "\n");
  await new Promise<void>(resolve => process.stdin.once("data", () => resolve()));
} finally {
  await fixture.close();
}
