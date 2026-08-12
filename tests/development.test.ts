import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import { createTestConfig } from "../src/config.js";
import { createForgeServer } from "../src/server.js";

test("development startup seeds a workspace and signs localhost in automatically", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-development-test-"));
  const config = createTestConfig(root, {
    bindAddress: "127.0.0.1",
    reachableAddress: "https://forge.tailnet.ts.net:55180",
    port: 55180,
    repositoryRoot: await realpath(process.cwd()),
    developmentAutoLogin: true,
  });
  const server = await createForgeServer(config);
  try {
    const remoteStatus = await server.app.inject({ method: "GET", url: "/api/auth/status", headers: { host: "forge.tailnet.ts.net:55180" } });
    expect(remoteStatus.json()).toEqual({ required: false, authenticated: false });

    const status = await server.app.inject({ method: "GET", url: "/api/auth/status", headers: { host: "localhost:55180" } });
    expect(status.json()).toEqual({ required: false, authenticated: true });
    const setCookies = Array.isArray(status.headers["set-cookie"]) ? status.headers["set-cookie"] : [status.headers["set-cookie"] ?? ""];
    const cookie = setCookies.find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`))?.split(";", 1)[0];
    expect(cookie).toBeDefined();
    expect(setCookies.find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`))).not.toContain("Secure");

    const companies = await server.app.inject({ method: "GET", url: "/api/companies", headers: { cookie: cookie! } });
    expect(companies.json()).toEqual({ companies: [expect.objectContaining({ name: "Development" })] });
    const projects = await server.app.inject({ method: "GET", url: "/api/projects", headers: { cookie: cookie! } });
    expect(projects.json()).toEqual({ projects: [expect.objectContaining({ name: "forge", status: "draft", repository: "meiji-industries/forge" })] });

    const created = await server.app.inject({ method: "POST", url: "/api/admin/companies", headers: { cookie: cookie!, origin: "http://localhost:55180" }, payload: { name: "Local mutation" } });
    expect(created.statusCode).toBe(201);
  } finally {
    await server.app.close();
    server.database.close();
    await rm(root, { recursive: true, force: true });
  }
});
