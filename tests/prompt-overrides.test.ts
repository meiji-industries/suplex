import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AuthService } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { PromptOverrideFailure, PromptOverrideService } from "../src/prompt-overrides.js";
import { ProjectService } from "../src/projects.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-prompt-override-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin', 'Admin', 'admin', 'admin', 'active', ?, ?)").run("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"));
  const config = createTestConfig(root);
  const auth = new AuthService(database, config);
  const projects = new ProjectService(database, auth, config);
  return { root, database, service: new PromptOverrideService(database, auth, projects, () => new Date("2026-08-01T00:00:00.000Z")) };
}

test("saves revisions and rolls back by appending a revision", async () => {
  const value = await fixture();
  try {
    expect(value.service.save("admin", "global", "lead/plan", { mode: "append", content: "one" }).currentRevision).toBe(1);
    expect(value.service.save("admin", "global", "lead/plan", { mode: "replace", content: "two" }).currentRevision).toBe(2);
    expect(value.service.rollback("admin", "global", "lead/plan", 1).currentRevision).toBe(3);
    expect(value.service.revisions("admin", "global", "lead/plan")[0]).toMatchObject({ revision: 3, restored_from_revision: 1, content: "one" });
    expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_audit_events WHERE action LIKE 'prompt_override_%'").get())).toEqual({ count: 3 });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("does not allow non-editable templates to be overridden", async () => {
  const value = await fixture();
  try {
    expect(() => value.service.save("admin", "global", "pull-request/body", { mode: "replace", content: "body" })).toThrow(PromptOverrideFailure);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});
