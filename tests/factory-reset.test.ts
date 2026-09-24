import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

import { providerInstancesDirectory } from "../src/profiles/provider-instances.js";
import { nativeApp } from "./helpers/native-app.js";

test("clearing the account waits for live sessions, then restores a first-start database that opens onboarding", async () => {
  const value = await nativeApp();
  try {
    const loopback = { host: "127.0.0.1:4111" };
    const reset = () => value.app.inject({ method: "POST", url: "/api/admin/factory-reset", headers: loopback });
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Active", description: "Keep active work", idempotencyKey: "active-task", startImmediately: true });
    expect((await reset()).statusCode).toBe(409);
    expect(value.tasks.getTask(value.userId, task.id).title).toBe("Active");
    value.tasks.cancelTask(value.userId, task.id);

    const worktree = join(value.project.worktreeRoot, "external-work");
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, "keep.txt"), "uncommitted work");
    await mkdir(join(value.config.artifactRoot, value.company.id), { recursive: true });
    await writeFile(join(value.config.artifactRoot, value.company.id, "attachment.png"), "artifact");
    await mkdir(join(providerInstancesDirectory(value.config.databasePath), "claude-home"), { recursive: true });

    expect((await reset()).statusCode).toBe(204);
    for (const table of ["suplex_tasks", "suplex_projects", "suplex_companies", "suplex_users", "suplex_sessions", "suplex_audit_events"]) {
      expect(value.database.authQuery(db => db.prepare(`SELECT count(*) AS n FROM ${table}`).get()), table).toEqual({ n: 0 });
    }
    expect(await readdir(value.config.artifactRoot)).toEqual([]);
    expect(existsSync(providerInstancesDirectory(value.config.databasePath))).toBe(false);
    expect(await readFile(join(worktree, "keep.txt"), "utf8")).toBe("uncommitted work");
    // The old session is gone. A trusted request signs in the first user, who starts onboarding.
    expect((await value.app.inject({ method: "GET", url: "/api/companies", headers: value.headers })).statusCode).toBe(401);
    expect((await value.app.inject({ method: "GET", url: "/", headers: loopback })).headers.location).toBe("/onboarding");
  } finally { await value.close(); }
});
