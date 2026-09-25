import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { taskSessionRuntimeDirectory } from "../../src/runtimes/task-harness.js";
import { nativeApp } from "../helpers/native-app.js";

const fixture = await nativeApp();
try {
  fixture.profiles.update(fixture.userId, fixture.project.rootProfileId, { provider: "codex" });
  const create = async (key: string) => (await fixture.tasks.createTask(fixture.userId, fixture.company.id, {
    projectId: fixture.project.id,
    title: key,
    description: "Read native task agent status",
    startImmediately: true,
    idempotencyKey: key,
  })).task;
  const first = await create("agents-first");
  const second = await create("agents-second");
  const idle = await create("agents-idle");
  const archived = await create("agents-archived");
  const controls = fixture.tasks.repository.controls;
  const unknown = controls.claimRoot({ taskId: first.id });
  controls.bindHarnessSession({ sessionId: unknown.id, generation: unknown.generation, nativeSessionId: "codex-missing" });
  controls.claimRoot({ taskId: second.id });
  const idleRoot = controls.claimRoot({ taskId: idle.id });
  controls.bindHarnessSession({ sessionId: idleRoot.id, generation: idleRoot.generation, nativeSessionId: "codex-idle" });
  // The native ID, rather than a saved profile, selects the source reader.
  fixture.database.authTransaction(db => db.prepare("UPDATE suplex_task_sessions SET profile_json = json_set(profile_json, '$.provider', 'opencode') WHERE id = ?").run(idleRoot.id));
  const runtime = taskSessionRuntimeDirectory(fixture.config.databasePath, idleRoot.id);
  await mkdir(runtime, { recursive: true });
  const record = join(runtime, "turn.json");
  await writeFile(record, JSON.stringify({
    generation: "00000000-0000-4000-8000-000000000001",
    turnId: "msg_idle",
    sessionID: "codex-idle",
    pid: 999999,
    processIdentity: {
      command: "codex exec", executable: "codex", argv: ["codex", "exec"],
      processGroup: 999999, startTime: "gone", ownerUid: 0,
    },
  }));
  const time = new Date("2026-09-25T12:34:56.000Z");
  await utimes(record, time, time);
  fixture.database.authTransaction(db => db.prepare("UPDATE suplex_tasks SET archived_at = ? WHERE id = ?").run(time.toISOString(), archived.id));

  const query = new URLSearchParams([second.id, first.id, idle.id, archived.id, "missing", first.id].map(id => ["taskId", id]));
  const tooMany = new URLSearchParams(Array.from({ length: 11 }, (_, index) => ["taskId", String(index)]));
  const batchPath = `/api/companies/${fixture.company.id}/task-agents?${query}`;
  const read = async (path: string) => {
    const response = await fixture.app.inject({ url: path, headers: fixture.headers });
    return {
      status: response.statusCode,
      body: JSON.parse(response.body) as unknown,
      cacheControl: response.headers["cache-control"] ?? null,
    };
  };
  process.stdout.write(JSON.stringify({
    databasePath: fixture.config.databasePath,
    companyId: fixture.company.id,
    firstId: first.id,
    idleId: idle.id,
    cookie: fixture.headers.cookie,
    batchPath,
    batch: await read(batchPath),
    first: await read(`/api/tasks/${first.id}/agents`),
    idle: await read(`/api/tasks/${idle.id}/agents`),
    empty: await read(`/api/companies/${fixture.company.id}/task-agents`),
    invalid: await read(`/api/companies/${fixture.company.id}/task-agents?taskId=`),
    tooMany: await read(`/api/companies/${fixture.company.id}/task-agents?${tooMany}`),
  }) + "\n");
  await new Promise<void>(resolve => process.stdin.once("data", () => resolve()));
  fixture.database.authTransaction(db => db.prepare("UPDATE suplex_tasks SET archived_at = ? WHERE id = ?").run(time.toISOString(), first.id));
  await rm(record);
  process.stdout.write(JSON.stringify({
    batch: await read(batchPath),
    idle: await read(`/api/tasks/${idle.id}/agents`),
  }) + "\n");
  await new Promise<void>(resolve => process.stdin.once("data", () => resolve()));
  fixture.database.authTransaction(db => db.prepare("UPDATE suplex_users SET status = 'revoked' WHERE id = ?").run(fixture.userId));
  process.stdout.write(JSON.stringify({
    batch: await read(batchPath),
    idle: await read(`/api/tasks/${idle.id}/agents`),
  }) + "\n");
  await new Promise<void>(resolve => process.stdin.once("data", () => resolve()));
} finally {
  await fixture.close();
}
