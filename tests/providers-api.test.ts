import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/identity/auth.js";
import * as executables from "../src/platform/executable-resolver.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/identity/auth-identifiers.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/platform/config.js";
import { ForgeDatabase } from "../src/platform/database.js";
import { ProviderInstanceService } from "../src/profiles/provider-instances.js";
import { healthyHost } from "./helpers/native-app.js";

const webAuthn: WebAuthnAdapter = { async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "provider-api", pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }], attestation: "none" as const }; }, async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1]), counter: 0 } }; }, async generateAuthenticationOptions() { return { challenge: "provider-api", rpId: "localhost", allowCredentials: [], userVerification: "required" as const }; }, async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; } };

afterEach(() => vi.restoreAllMocks());

function cookie(headers: OutgoingHttpHeaders, name: string): string {
  const all = Array.isArray(headers["set-cookie"]) ? headers["set-cookie"] : [headers["set-cookie"] ?? ""];
  return (all.find((value) => value.split("=", 1)[0] === name) ?? "").split(";", 1)[0]!.split("=", 2)[1] ?? "";
}

test("provider API uses native configuration, not CLI health or Forge credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-providers-api-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111" });
  const auth = new AuthService(database, config, { webAuthn });
  const providerInstances = new ProviderInstanceService(database, auth);
  let failObservation = false;
  const app = createApp({ config, auth, database, health: healthyHost, providerInstances, readProviderInstanceReadiness: async homeDirectory => ({ status: "healthy", summary: `Ready: ${homeDirectory}` }), readProviders: async () => {
    if (failObservation) throw new Error("native server failed");
    return { directory: root, observedAt: new Date().toISOString(), providers: [
      { id: "opencode" as const, label: "OpenCode", modelCount: 2, models: [{ id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol (OpenAI)" }, { id: "opencode/gpt-5.6-luna", label: "GPT-5.6 Luna (OpenCode Zen)" }], status: "configured" as const, connection: { status: "connected" as const, summary: "Signed in" } },
      { id: "devin" as const, label: "Devin CLI", modelCount: 1, models: [{ id: "swe-2", label: "SWE-2" }], status: "missing" as const, connection: { status: "not-connected" as const, summary: "Not installed" } },
    ] };
  } });
  try {
    const invitation = auth.ensureBootstrapInvitation()!;
    const options = await app.inject({ method: "POST", url: "/api/auth/bootstrap/options", payload: { token: invitation.token } });
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/bootstrap/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "provider-admin", type: "public-key" } } });
    const session = cookie(enrolled.headers, SESSION_COOKIE_NAME); const csrf = cookie(enrolled.headers, CSRF_COOKIE_NAME);
    const headers = { cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`, origin: config.reachableAddress, "x-csrf-v1": csrf };
    const listed = await app.inject({ method: "GET", url: "/api/admin/providers", headers });
    expect(listed.json()).toMatchObject({ providers: [
      { id: "opencode", status: "configured", modelCount: 2, connection: { status: "connected" } },
      { id: "devin", status: "missing", connection: { status: "not-connected" } },
    ] });
    expect(listed.headers["cache-control"]).toBe("private, no-store");
    expect(listed.body).not.toContain("healthy");
    expect(listed.body).not.toContain("claude");
    expect((await app.inject({ method: "PUT", url: "/api/admin/providers/openrouter/credential", headers, payload: { apiKey: "not-a-real-key" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/admin/providers/openrouter/credential", headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/admin/providers/openrouter/test", headers })).statusCode).toBe(404);
    const created = await app.inject({ method: "POST", url: "/api/admin/provider-instances", headers, payload: { provider: "claude-code", label: "Local" } });
    expect(created.statusCode, created.body).toBe(201);
    const instance = created.json();
    const listedInstances = await app.inject({ method: "GET", url: "/api/admin/provider-instances", headers });
    expect(listedInstances.json()).toMatchObject({ instances: [{ id: instance.id, readiness: { status: "healthy", summary: expect.stringContaining("Ready:") }, connection: { status: "connected" } }] });
    expect((await app.inject({ method: "POST", url: "/api/admin/provider-instances", headers, payload: { provider: "opencode", label: "No" } })).statusCode).toBe(422);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/provider-instances/${instance.id}`, headers })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/provider-instances/${instance.id}`, headers })).statusCode).toBe(404);
    failObservation = true;
    const failed = await app.inject({ method: "GET", url: "/api/admin/providers", headers });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).not.toHaveProperty("providers");
  } finally { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});

test("provider login endpoints create, reuse, and close Herdr sign-in panes", async () => {
  vi.spyOn(executables, "resolveClaudeExecutable").mockResolvedValue("/opt/claude/bin/claude");
  vi.spyOn(executables, "resolveDevinExecutable").mockResolvedValue("/opt/devin/devin");
  vi.spyOn(executables, "resolveOpenCodeExecutable").mockRejectedValue(new Error("missing"));
  const root = await mkdtemp(join(tmpdir(), "forge-provider-login-api-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111" });
  const auth = new AuthService(database, config, { webAuthn });
  const providerInstances = new ProviderInstanceService(database, auth);
  const panes = new Map<string, { paneId: string }>();
  let paneSeq = 0;
  const herdr = {
    getPane: vi.fn(async (id: string) => panes.get(id) ?? null),
    createWorkspace: vi.fn(async () => {
      const pane = { paneId: `pane-login-${++paneSeq}` };
      panes.set(pane.paneId, pane);
      return { workspace: { workspaceId: `ws-login-${paneSeq}`, label: "forge-provider-login" }, tab: { tabId: `tab-${paneSeq}`, label: "sign-in" }, rootPane: pane };
    }),
    runPaneCommand: vi.fn(async () => {}),
    closePane: vi.fn(async () => {}),
    closeWorkspace: vi.fn(async () => {}),
  };
  const app = createApp({ config, auth, database, health: healthyHost, providerInstances, providerLoginHerdr: herdr, readProviderInstanceReadiness: async () => ({ status: "unhealthy", summary: "Not signed in" }), readProviders: async () => ({ directory: root, observedAt: new Date().toISOString(), providers: [] }) });
  try {
    const invitation = auth.ensureBootstrapInvitation()!;
    const options = await app.inject({ method: "POST", url: "/api/auth/bootstrap/options", payload: { token: invitation.token } });
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/bootstrap/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "login-admin", type: "public-key" } } });
    const session = cookie(enrolled.headers, SESSION_COOKIE_NAME); const csrf = cookie(enrolled.headers, CSRF_COOKIE_NAME);
    const headers = { cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`, origin: config.reachableAddress, "x-csrf-v1": csrf };
    const userId = enrolled.json().user.id as string;

    expect((await app.inject({ method: "POST", url: "/api/admin/providers/claude-code/login" })).statusCode).toBe(401);

    const claude = await app.inject({ method: "POST", url: "/api/admin/providers/claude-code/login", headers });
    expect(claude.statusCode, claude.body).toBe(200);
    expect(herdr.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ label: "forge-provider-login", focus: false }));
    expect(herdr.runPaneCommand).toHaveBeenLastCalledWith("pane-login-1", "'/opt/claude/bin/claude' auth login");

    const reused = await app.inject({ method: "POST", url: "/api/admin/providers/claude-code/login", headers });
    expect(reused.json().paneId).toBe("pane-login-1");
    expect(herdr.createWorkspace).toHaveBeenCalledTimes(1);

    await app.inject({ method: "POST", url: "/api/admin/providers/devin/login", headers });
    expect(herdr.runPaneCommand).toHaveBeenLastCalledWith("pane-login-2", "'/opt/devin/devin' auth login");
    // A new sign-in closes the earlier session instead of orphaning its workspace.
    expect(herdr.closePane).toHaveBeenCalledWith("pane-login-1");
    expect(herdr.closeWorkspace).toHaveBeenCalledWith("ws-login-1");
    expect((await app.inject({ method: "DELETE", url: "/api/admin/provider-login/pane-login-1", headers })).statusCode).toBe(404);

    await app.inject({ method: "POST", url: "/api/admin/providers/opencode/login", headers });
    // OpenCode resolution failed, so the pane keeps a best-effort bare command.
    expect(herdr.runPaneCommand).toHaveBeenLastCalledWith("pane-login-3", "opencode auth login");
    // A vendor is not an agent tool, so it has no sign-in of its own.
    expect((await app.inject({ method: "POST", url: "/api/admin/providers/openai/login", headers })).statusCode).toBe(400);

    const created = await app.inject({ method: "POST", url: "/api/admin/provider-instances", headers, payload: { provider: "claude-code", label: "Work" } });
    const instance = created.json();
    const instanceLogin = await app.inject({ method: "POST", url: `/api/admin/provider-instances/${instance.id}/login`, headers });
    expect(instanceLogin.statusCode, instanceLogin.body).toBe(200);
    expect(herdr.runPaneCommand).toHaveBeenLastCalledWith("pane-login-4", `CLAUDE_CONFIG_DIR='${instance.homeDirectory}' '/opt/claude/bin/claude' auth login`);
    expect((await app.inject({ method: "POST", url: "/api/admin/provider-instances/instance_missing/login", headers })).statusCode).toBe(404);

    const listed = await app.inject({ method: "GET", url: "/api/admin/provider-instances", headers });
    expect(listed.json()).toMatchObject({ instances: [{ id: instance.id, connection: { status: "not-connected" } }] });

    database.authTransaction(db => db.prepare("UPDATE forge_users SET role = 'member' WHERE id = ?").run(userId));
    expect((await app.inject({ method: "POST", url: "/api/admin/providers/devin/login", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/api/admin/provider-login/pane-login-1", headers })).statusCode).toBe(403);
    database.authTransaction(db => db.prepare("UPDATE forge_users SET role = 'admin' WHERE id = ?").run(userId));

    expect((await app.inject({ method: "DELETE", url: "/api/admin/provider-login/pane-login-4", headers })).statusCode).toBe(204);
    expect(herdr.closeWorkspace).toHaveBeenCalledWith("ws-login-4");
    expect((await app.inject({ method: "DELETE", url: "/api/admin/provider-login/pane-login-4", headers })).statusCode).toBe(404);
  } finally { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});
