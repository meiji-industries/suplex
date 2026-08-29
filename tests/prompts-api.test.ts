import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createApp } from "../src/app.js";
import { AuthService } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { ProjectService } from "../src/projects.js";

const health = { engine: async () => ({ id: "engine" as const, label: "Engine", status: "healthy" as const, summary: "Ready", details: {} }), database: async () => ({ id: "database" as const, label: "Database", status: "healthy" as const, summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root" as const, label: "Artifacts", status: "healthy" as const, summary: "Ready", details: {} }), worker: async () => ({ id: "worker" as const, label: "Worker", status: "healthy" as const, summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth" as const, label: "Codex", status: "healthy" as const, summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth" as const, label: "GitHub", status: "healthy" as const, summary: "Ready", details: {} }) };

test("manages global prompt overrides through the API", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-prompts-api-test-"));
  const config = createTestConfig(root, { developmentAutoLogin: true });
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const auth = new AuthService(database, config);
  const projects = new ProjectService(database, auth, config);
  const session = auth.developmentSignIn();
  const headers = { cookie: `forge_session=${session.sessionToken}`, origin: config.reachableAddress };
  const app = createApp({ config, auth, projects, database, health });
  try {
    const list = await app.inject({ method: "GET", url: "/api/prompts/templates?scope=global", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ templates: expect.arrayContaining([expect.objectContaining({ id: "lead/plan", override: null })]) });
    const saved = await app.inject({ method: "PUT", url: "/api/prompts/templates/lead%2Fplan/override?scope=global", headers, payload: { mode: "append", content: "Use {{title}}." } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ id: "lead/plan", override: { mode: "append", currentRevision: 1 }, revisions: [expect.objectContaining({ revision: 1 })] });
    const detail = await app.inject({ method: "GET", url: "/api/prompts/templates/lead%2Fplan?scope=global", headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ resolved: { guidance: expect.stringContaining("Use {{title}}.") } });
    const preview = await app.inject({ method: "POST", url: "/api/prompts/templates/lead%2Fplan/preview?scope=global", headers, payload: { mode: "replace", content: "Preview {{title}}" } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ findings: [], resolved: { guidance: "Preview {{title}}" } });
    const invalid = await app.inject({ method: "PUT", url: "/api/prompts/templates/lead%2Fplan/override?scope=global", headers, payload: { mode: "append", content: "{{not_allowed}}" } });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ findings: [expect.objectContaining({ code: "unknown_variable" })] });
    const rollback = await app.inject({ method: "POST", url: "/api/prompts/templates/lead%2Fplan/rollback?scope=global", headers, payload: { revision: 1 } });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json()).toMatchObject({ override: { currentRevision: 2 } });
    expect((rollback.json() as { revisions: unknown[] }).revisions).toEqual(expect.arrayContaining([expect.objectContaining({ revision: 2, restored_from_revision: 1 })]));
    expect((await app.inject({ method: "GET", url: "/api/prompts/templates/unknown%2Ftemplate?scope=global", headers })).statusCode).toBe(404);
  } finally {
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
