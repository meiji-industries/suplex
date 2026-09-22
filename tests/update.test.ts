import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { AuthService } from "../src/identity/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/platform/config.js";
import { SuplexDatabase } from "../src/platform/database.js";
import type { HostHealthDependencies } from "../src/platform/health.js";
import { UpdateResponseSchema } from "../src/http/contracts/update.js";

const revision = "b".repeat(40);
const health: HostHealthDependencies = {
  database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }),
  artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }),
  ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
};

test("the update API returns supervisor state and requests an explicit check", async () => {
  const root = await mkdtemp(join(tmpdir(), "suplex-update-api-"));
  const config = createTestConfig(root, { developmentAutoLogin: true });
  const database = new SuplexDatabase(config.databasePath);
  const auth = new AuthService(database, config);
  const checks: boolean[] = [];
  const app = createApp({
    config,
    auth,
    health,
    instanceId: "server-instance",
    readUpdate: async (check) => { checks.push(check); return { status: { kind: "available" }, availableRevision: revision, canRestart: true }; },
    requestUpdateRestart: async () => ({ accepted: true, status: { kind: "applying", step: "fetch", message: "Suplex checks the update." } }),
  });
  try {
    const anonymous = await app.inject({ method: "GET", url: "/api/update" });
    expect(anonymous.statusCode).toBe(401);
    const response = await app.inject({ method: "GET", url: "/api/update?check=1", headers: { host: `127.0.0.1:${config.port}` } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(UpdateResponseSchema.parse(response.json())).toEqual({ status: { kind: "available" }, availableRevision: revision, canRestart: true, instanceId: "server-instance" });
    expect(checks).toEqual([true]);
    const setCookie = response.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
    database.authTransaction((db) => db.prepare("UPDATE suplex_users SET role = 'member' WHERE username = 'operator@suplex.local'").run());
    const memberRead = await app.inject({ method: "GET", url: "/api/update", headers: { host: `127.0.0.1:${config.port}`, ...(cookie ? { cookie } : {}) } });
    expect(memberRead.statusCode).toBe(200);
    expect(UpdateResponseSchema.parse(memberRead.json()).canRestart).toBe(false);
    const memberRestart = await app.inject({ method: "POST", url: "/api/update/restart", headers: { host: `127.0.0.1:${config.port}`, ...(cookie ? { cookie } : {}) } });
    expect(memberRestart.statusCode).toBe(403);
    database.authTransaction((db) => db.prepare("UPDATE suplex_users SET role = 'admin' WHERE username = 'operator@suplex.local'").run());
    const accepted = await app.inject({ method: "POST", url: "/api/update/restart", headers: { host: `127.0.0.1:${config.port}` } });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ accepted: true, status: { kind: "applying", step: "fetch", message: "Suplex checks the update." } });
  } finally {
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the update API reports a missing supervisor capability truthfully", async () => {
  const root = await mkdtemp(join(tmpdir(), "suplex-update-api-capability-"));
  const config = createTestConfig(root, { developmentAutoLogin: true });
  const database = new SuplexDatabase(config.databasePath);
  const auth = new AuthService(database, config);
  const app = createApp({ config, auth, health, readUpdate: async () => ({ status: { kind: "failed", action: "check", message: "Suplex update control is not available.", error: "Start Suplex with the Suplex supervisor." }, canRestart: false }) });
  try {
    const response = await app.inject({ method: "GET", url: "/api/update", headers: { host: `127.0.0.1:${config.port}` } });
    expect(UpdateResponseSchema.parse(response.json()).canRestart).toBe(false);
  } finally {
    await app.close(); database.close(); await rm(root, { recursive: true, force: true });
  }
});
