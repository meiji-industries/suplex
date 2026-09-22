import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { applyMigrations } from "../src/platform/database.js";

test("queued migration preserves control evidence and upgrades historical command receipts", () => {
  const source = resolve("drizzle");
  const oldMigrations = mkdtempSync(join(tmpdir(), "forge-queued-migrations-"));
  const database = new Database(":memory:");
  try {
    for (const name of readdirSync(source).filter(name => name.endsWith(".sql") && name < "20260922030041770_canonical_queued_task_status.sql")) {
      cpSync(join(source, name), join(oldMigrations, name));
    }
    applyMigrations(database, oldMigrations);
    database.pragma("foreign_keys = OFF");
    const tasks = [
      ["manual", 0, null, "backlog"],
      ["queued", 1, null, "backlog"],
      ["archived", 1, "archived", "backlog"],
      ["running", 1, null, "active"],
      ["cancelled", 1, null, "cancelled"],
      ["delivered", 1, null, "delivered"],
    ] as const;
    for (const [id, startQueued, archivedAt, status] of tasks) {
      database.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, description, configuration_json, idempotency_key, request_hash, creator_user_id, created_at, updated_at, archived_at, start_queued) VALUES (?, 'company', 'project', ?, '', '{}', ?, 'request-hash', 'user', 'created', 'updated', ?, ?)").run(id, id, id, archivedAt, startQueued);
      database.prepare("INSERT INTO forge_task_controls (task_id, objective, delivery_target, delivery_intent_json, status, root_profile_json, worker_profile_json, created_at, updated_at, status_changed_at) VALUES (?, ?, 'local_worktree', '{}', ?, '{}', '{}', 'created', 'updated', 'historical')").run(id, id, status);
    }
    const receipt = {
      status: "backlog",
      revision: "historical-revision",
      queue: { startIntent: "queued", state: "queued", waitingOn: [{ id: "queued", status: "backlog", queued: true }] },
      blockedBy: [{ id: "queued", status: "backlog", queued: true }],
    };
    database.prepare("INSERT INTO forge_hermes_task_command_receipts (agent_id, task_id, idempotency_key, request_hash, result_json, created_at) VALUES ('agent', 'queued', 'start', 'original-hash', ?, 'created')").run(JSON.stringify(receipt));
    const controlsBefore = database.prepare("SELECT * FROM forge_task_controls ORDER BY task_id").all() as Array<Record<string, unknown>>;
    const foreignKeysBefore = database.pragma("foreign_key_list(forge_task_controls)");
    applyMigrations(database, source);
    applyMigrations(database, source);
    expect(database.prepare("SELECT * FROM forge_task_controls ORDER BY task_id").all()).toEqual(controlsBefore.map(control =>
      control.task_id === "queued" ? { ...control, status: "queued" } : control,
    ));
    expect((database.pragma("table_info(forge_tasks)") as Array<{ name: string }>).some(column => column.name === "start_queued")).toBe(false);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'forge_tasks_start_queued_idx'").get()).toBeUndefined();
    expect(database.pragma("foreign_key_list(forge_task_controls)")).toEqual(foreignKeysBefore);
    const stored = database.prepare("SELECT request_hash AS hash, result_json AS result FROM forge_hermes_task_command_receipts WHERE task_id = 'queued'").get() as { hash: string; result: string };
    expect(stored.hash).toBe("original-hash");
    expect(JSON.parse(stored.result)).toEqual({
      status: "queued",
      revision: "historical-revision",
      queue: { waitingOn: [{ id: "queued", status: "queued" }] },
      blockedBy: [{ id: "queued", status: "queued" }],
    });
    expect(() => database.prepare("UPDATE forge_task_controls SET status = 'invalid' WHERE task_id = 'queued'").run()).toThrow();
    database.prepare("UPDATE forge_task_controls SET status = 'active' WHERE task_id = 'queued'").run();
    expect((database.prepare("SELECT status_changed_at AS changed FROM forge_task_controls WHERE task_id = 'queued'").get() as { changed: string }).changed).not.toBe("historical");
  } finally {
    database.close();
    rmSync(oldMigrations, { recursive: true, force: true });
  }
});
