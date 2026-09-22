import { createHash } from "node:crypto";
import { createServer } from "node:net";

import { afterEach, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { nativeApp } from "./helpers/native-app.js";
import { OAuthService } from "../src/identity/oauth.js";

const fixtures: Array<Awaited<ReturnType<typeof nativeApp>>> = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

function csrfHeaders(headers: { cookie: string; origin: string }): Record<string, string> {
  const csrf = headers.cookie.split("; ").find((entry) => entry.startsWith("csrf_v1="))?.slice("csrf_v1=".length);
  if (!csrf) throw new Error("Missing CSRF cookie");
  return { ...headers, "x-csrf-v1": csrf };
}

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function register(fixture: Awaited<ReturnType<typeof nativeApp>>, name = "Claude") {
  const response = await fixture.app.inject({ method: "POST", url: "/oauth/register", payload: {
    client_name: name,
    redirect_uris: ["http://127.0.0.1:9317/callback"],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
    client_uri: "https://claude.ai", logo_uri: "https://claude.ai/logo.png", contacts: ["support@example.test"], software_id: "claude-code", software_version: "1.0", scope: "suplex:mcp", application_type: "native",
  } });
  expect(response.statusCode).toBe(201);
  return response.json() as { client_id: string };
}

async function authorize(fixture: Awaited<ReturnType<typeof nativeApp>>, clientId: string, verifier: string, state = "opaque-state") {
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: "http://127.0.0.1:9317/callback", response_type: "code", state, scope: "suplex:mcp", resource: fixture.oauth.resource, code_challenge: challenge(verifier), code_challenge_method: "S256" });
  const start = await fixture.app.inject({ method: "GET", url: `/oauth/authorize?${query}`, headers: fixture.headers });
  expect(start.statusCode).toBe(302);
  const requestId = new URL(start.headers.location!, fixture.config.reachableAddress).searchParams.get("request")!;
  const consent = await fixture.app.inject({ method: "GET", url: `/api/oauth/consent/${requestId}`, headers: fixture.headers });
  expect(consent.statusCode).toBe(200);
  const approval = await fixture.app.inject({ method: "POST", url: `/api/oauth/consent/${requestId}/approve`, headers: csrfHeaders(fixture.headers), payload: { companyId: fixture.company.id, projectIds: [fixture.project.id] } });
  expect(approval.statusCode).toBe(200);
  const callback = new URL(approval.json().redirectTo);
  expect(callback.searchParams.get("state")).toBe(state);
  expect(callback.searchParams.get("iss")).toBe(fixture.oauth.issuer);
  return callback.searchParams.get("code")!;
}

async function exchange(fixture: Awaited<ReturnType<typeof nativeApp>>, clientId: string, code: string, verifier: string) {
  return fixture.app.inject({ method: "POST", url: "/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: "http://127.0.0.1:9317/callback", resource: fixture.oauth.resource, code_verifier: verifier }).toString() });
}

test("OAuth discovery, DCR, explicit consent, PKCE, rotation, replay, revocation, and reapproval preserve authority", async () => {
  const fixture = await nativeApp(); fixtures.push(fixture);
  const metadata = await fixture.app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource/mcp" });
  expect(metadata.statusCode).toBe(200);
  expect(metadata.json()).toMatchObject({ resource: fixture.oauth.resource, authorization_servers: [fixture.oauth.issuer] });
  const unauthenticated = await fixture.app.inject({ method: "POST", url: "/mcp", headers: { host: new URL(fixture.config.reachableAddress).host }, payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } } });
  expect(unauthenticated.statusCode).toBe(401);
  expect(unauthenticated.headers["www-authenticate"]).toContain("oauth-protected-resource/mcp");

  const client = await register(fixture);
  const verifier = "v".repeat(43);
  const code = await authorize(fixture, client.client_id, verifier);
  const wrong = await exchange(fixture, client.client_id, code, "w".repeat(43));
  expect(wrong.statusCode).toBe(400);
  expect(wrong.json()).toMatchObject({ error: "invalid_grant" });
  const wrongClient = await exchange(fixture, "oauth_client_wrong", code, verifier);
  expect(wrongClient.statusCode).toBe(400);
  const wrongRedirect = await fixture.app.inject({ method: "POST", url: "/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: "http://localhost:9999/callback", resource: fixture.oauth.resource, code_verifier: verifier }).toString() });
  expect(wrongRedirect.statusCode).toBe(400);
  const wrongResource = await fixture.app.inject({ method: "POST", url: "/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: "http://127.0.0.1:9317/callback", resource: `${fixture.oauth.issuer}/other`, code_verifier: verifier }).toString() });
  expect(wrongResource.statusCode).toBe(400);
  const tokens = await exchange(fixture, client.client_id, code, verifier);
  expect(tokens.statusCode).toBe(200);
  const first = tokens.json() as { access_token: string; refresh_token: string };
  const replayCode = await exchange(fixture, client.client_id, code, verifier);
  expect(replayCode.statusCode).toBe(400);

  const expandedScope = await fixture.app.inject({ method: "POST", url: "/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: client.client_id, resource: fixture.oauth.resource, scope: "suplex:mcp suplex:admin", extension: "ignored" }).toString() });
  expect(expandedScope.statusCode).toBe(400);
  expect(expandedScope.json()).toMatchObject({ error: "invalid_scope" });
  const refresh = await fixture.app.inject({ method: "POST", url: "/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: client.client_id, resource: fixture.oauth.resource, scope: "suplex:mcp", extension: "ignored" }).toString() });
  expect(refresh.statusCode).toBe(200);
  const rotated = refresh.json() as { access_token: string; refresh_token: string };
  const reuse = await fixture.app.inject({ method: "POST", url: "/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: client.client_id, resource: fixture.oauth.resource }).toString() });
  expect(reuse.statusCode).toBe(400);
  const familyRevoked = await fixture.app.inject({ method: "POST", url: "/mcp", headers: { host: new URL(fixture.config.reachableAddress).host, authorization: `Bearer ${rotated.access_token}` }, payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } } });
  expect(familyRevoked.statusCode).toBe(401);

  const agent = fixture.database.authQuery((db) => db.prepare("SELECT agent_id FROM suplex_oauth_grants WHERE client_id = ?").get(client.client_id) as { agent_id: string });
  const activeCode = await authorize(fixture, client.client_id, verifier, "active-before-revoke");
  const activeTokensResponse = await exchange(fixture, client.client_id, activeCode, verifier);
  const activeTokens = activeTokensResponse.json() as { access_token: string; refresh_token: string };
  fixture.externalAgent.revoke(fixture.userId, agent.agent_id);
  const revokedRefresh = await fixture.app.inject({ method: "POST", url: "/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ grant_type: "refresh_token", refresh_token: activeTokens.refresh_token, client_id: client.client_id, resource: fixture.oauth.resource }).toString() });
  expect(revokedRefresh.statusCode).toBe(400);
  const newCode = await authorize(fixture, client.client_id, verifier, "reapprove");
  const reapproved = await exchange(fixture, client.client_id, newCode, verifier);
  expect(reapproved.statusCode).toBe(200);
  const sameAgent = fixture.database.authQuery((db) => db.prepare("SELECT agent_id FROM suplex_oauth_grants WHERE client_id = ?").get(client.client_id) as { agent_id: string });
  expect(sameAgent.agent_id).toBe(agent.agent_id);
  const outstandingCode = await authorize(fixture, client.client_id, verifier, "outstanding");
  fixture.externalAgent.revoke(fixture.userId, agent.agent_id);
  const freshCode = await authorize(fixture, client.client_id, verifier, "fresh");
  expect((await exchange(fixture, client.client_id, outstandingCode, verifier)).statusCode).toBe(400);
  expect((await exchange(fixture, client.client_id, freshCode, verifier)).statusCode).toBe(200);
});

test("authorization denial preserves state and does not grant on GET", async () => {
  const fixture = await nativeApp(); fixtures.push(fixture);
  const client = await register(fixture);
  const verifier = "v".repeat(43);
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: "http://127.0.0.1:9317/callback", response_type: "code", state: "deny-state", scope: "suplex:mcp", resource: fixture.oauth.resource, code_challenge: challenge(verifier), code_challenge_method: "S256" });
  const start = await fixture.app.inject({ method: "GET", url: `/oauth/authorize?${query}`, headers: fixture.headers });
  const requestId = new URL(start.headers.location!, fixture.config.reachableAddress).searchParams.get("request")!;
  const expiredSession = await fixture.app.inject({ method: "GET", url: `/oauth/consent?request=${requestId}` });
  expect(expiredSession.statusCode).toBe(302);
  expect(expiredSession.headers.location).toBe(`/auth?returnTo=${encodeURIComponent(`/oauth/consent?request=${requestId}`)}`);
  expect(fixture.database.authQuery((db) => (db.prepare("SELECT COUNT(*) AS count FROM suplex_oauth_grants").get() as { count: number }).count)).toBe(0);
  const denied = await fixture.app.inject({ method: "POST", url: `/api/oauth/consent/${requestId}/deny`, headers: csrfHeaders(fixture.headers), payload: {} });
  const callback = new URL(denied.json().redirectTo);
  expect(callback.searchParams.get("error")).toBe("access_denied");
  expect(callback.searchParams.get("state")).toBe("deny-state");
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test("official SDK discovers OAuth and calls Suplex tools without an agent key", async () => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const fixture = await nativeApp({ reachableAddress: origin }); fixtures.push(fixture);
  const uiTask = (await fixture.tasks.createTask(fixture.userId, fixture.company.id, {
    projectId: fixture.project.id,
    title: "Created through the Suplex UI",
    idempotencyKey: "oauth-visible-ui-task",
  })).task;
  fixture.tasks.repository.controls.start(uiTask.id);
  await fixture.app.listen({ host: "127.0.0.1", port });

  let clientInformation: OAuthClientInformationMixed | undefined;
  let tokens: OAuthTokens | undefined;
  let verifier = "";
  let authorizationCode = "";
  const provider: OAuthClientProvider = {
    redirectUrl: "http://127.0.0.1:9318/callback",
    clientMetadata: { client_name: "SDK integration", redirect_uris: ["http://127.0.0.1:9318/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
    clientInformation: () => clientInformation,
    saveClientInformation: (value) => { clientInformation = value; },
    tokens: () => tokens,
    saveTokens: (value) => { tokens = value; },
    state: () => "sdk-state",
    saveCodeVerifier: (value) => { verifier = value; },
    codeVerifier: () => verifier,
    redirectToAuthorization: async (url) => {
      const started = await fetch(url, { redirect: "manual" });
      const cookie = started.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
      const consentUrl = new URL(started.headers.get("location")!, origin);
      const requestId = consentUrl.searchParams.get("request")!;
      const csrf = cookie.split("; ").find((entry) => entry.startsWith("csrf_v1="))!.slice("csrf_v1=".length);
      const approval = await fetch(`${origin}/api/oauth/consent/${requestId}/approve`, { method: "POST", headers: { cookie, origin, "x-csrf-v1": csrf, "content-type": "application/json" }, body: JSON.stringify({ companyId: fixture.company.id, projectIds: [fixture.project.id] }) });
      const callback = new URL((await approval.json() as { redirectTo: string }).redirectTo);
      authorizationCode = callback.searchParams.get("code")!;
    },
  };
  let transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider });
  const client = new Client({ name: "suplex-sdk-test", version: "1.0.0" });
  await expect(client.connect(transport as unknown as Transport)).rejects.toThrow();
  expect(authorizationCode).not.toBe("");
  await transport.finishAuth(authorizationCode);
  transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider });
  await client.connect(transport as unknown as Transport);
  const listed = await client.listTools();
  expect(listed.tools.map(({ name }) => name)).toContain("suplex_whoami");
  const identity = await client.callTool({ name: "suplex_whoami", arguments: {} });
  expect(identity.structuredContent).toMatchObject({ status: 200, body: { agent: { id: expect.stringMatching(/^agent_/) } } });
  const visible = await client.callTool({ name: "suplex_list_tasks", arguments: { status: "active" } });
  expect(visible.structuredContent).toMatchObject({ status: 200, body: { tasks: [expect.objectContaining({ id: uiTask.id, status: "active" })] } });
  const uiRead = await client.callTool({ name: "suplex_get_task", arguments: { taskId: uiTask.id } });
  expect(uiRead.structuredContent).toMatchObject({ status: 200, body: { id: uiTask.id, status: "active", permittedCommands: [] } });
  const uiDelivery = await client.callTool({ name: "suplex_get_task_delivery", arguments: { taskId: uiTask.id } });
  expect(uiDelivery.structuredContent).toMatchObject({ status: 200, body: { taskId: uiTask.id, taskStatus: "active" } });
  const deniedCommand = await client.callTool({ name: "suplex_command_task", arguments: { taskId: uiTask.id, command: "cancel_task", revision: (uiRead.structuredContent as { body: { revision: string } }).body.revision, idempotencyKey: "oauth-non-owner-command" } });
  expect(deniedCommand).toMatchObject({ isError: true, structuredContent: { status: 404, body: { code: "resource_not_found" } } });
  const created = await client.callTool({ name: "suplex_create_task", arguments: { projectId: fixture.project.id, title: "Created through remote MCP", idempotencyKey: "sdk-create-1" } });
  const taskId = (created.structuredContent as { body: { id: string } }).body.id;
  const read = await client.callTool({ name: "suplex_get_task", arguments: { taskId } });
  expect(read.structuredContent).toMatchObject({ status: 200, body: { id: taskId } });
  const revision = (read.structuredContent as { body: { revision: string } }).body.revision;
  const unchanged = await client.callTool({ name: "suplex_get_task", arguments: { taskId, knownRevision: revision } });
  expect(unchanged.structuredContent).toEqual({ unchanged: true, revision });
  const invalid = await client.callTool({ name: "suplex_get_task", arguments: {} });
  expect(invalid).toMatchObject({ isError: true, structuredContent: { status: 400, body: { code: "request_invalid" } } });
  await client.close();

  fixture.database.authTransaction((db) => db.prepare("UPDATE suplex_oauth_access_tokens SET expires_at = ?").run(new Date(0).toISOString()));
  const reconnected = new Client({ name: "suplex-sdk-test", version: "1.0.0" });
  const refreshedTransport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider });
  await reconnected.connect(refreshedTransport as unknown as Transport);
  expect(await reconnected.listTools()).toMatchObject({ tools: expect.any(Array) });
  await reconnected.close();
});

test("MCP bearer checks use live host, origin, authority, agent, grants, and durable OAuth state", async () => {
  const fixture = await nativeApp(); fixtures.push(fixture);
  const client = await register(fixture);
  const verifier = "p".repeat(43);
  const code = await authorize(fixture, client.client_id, verifier);
  const exchanged = await exchange(fixture, client.client_id, code, verifier);
  const token = (exchanged.json() as { access_token: string }).access_token;
  const host = new URL(fixture.config.reachableAddress).host;
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };

  const wrongHost = await fixture.app.inject({ method: "POST", url: "/mcp", headers: { host: "attacker.test", authorization: `Bearer ${token}` }, payload: initialize });
  expect(wrongHost.statusCode).toBe(403);
  const wrongOrigin = await fixture.app.inject({ method: "POST", url: "/mcp", headers: { host, origin: "https://attacker.test", authorization: `Bearer ${token}` }, payload: initialize });
  expect(wrongOrigin.statusCode).toBe(403);
  const malformed = await fixture.app.inject({ method: "POST", url: "/mcp", headers: { host, authorization: "Bearer wrong" }, payload: initialize });
  expect(malformed.statusCode).toBe(401);
  expect(malformed.headers["www-authenticate"]).toContain("resource_metadata");

  const grant = fixture.database.authQuery((db) => db.prepare("SELECT agent_id, cursor_key FROM suplex_oauth_grants WHERE client_id = ?").get(client.client_id) as { agent_id: string; cursor_key: string });
  fixture.database.authTransaction((db) => db.prepare("UPDATE suplex_external_agents SET client_profile_id = 'missing-profile' WHERE id = ?").run(grant.agent_id));
  expect(new OAuthService(fixture.database, fixture.auth, fixture.externalAgent, fixture.config.reachableAddress).authenticateAccessToken(token)).toMatchObject({ agentId: grant.agent_id, profileId: "missing-profile", projectIds: [fixture.project.id], cursorKey: grant.cursor_key });

  fixture.externalAgent.replaceProjects(fixture.userId, grant.agent_id, []);
  expect(fixture.oauth.authenticateAccessToken(token).projectIds).toEqual([]);
  fixture.externalAgent.replaceProjects(fixture.userId, grant.agent_id, [fixture.project.id]);
  fixture.database.authTransaction((db) => db.prepare("UPDATE suplex_users SET role = 'member' WHERE id = ?").run(fixture.userId));
  expect(() => fixture.oauth.authenticateAccessToken(token)).toThrow();
  fixture.database.authTransaction((db) => db.prepare("UPDATE suplex_users SET role = 'admin' WHERE id = ?").run(fixture.userId));
  expect(fixture.oauth.authenticateAccessToken(token).agentId).toBe(grant.agent_id);

  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: "http://127.0.0.1:9317/callback", response_type: "code", state: "csrf", scope: "suplex:mcp", resource: fixture.oauth.resource, code_challenge: challenge(verifier), code_challenge_method: "S256" });
  const start = await fixture.app.inject({ method: "GET", url: `/oauth/authorize?${query}`, headers: fixture.headers });
  const requestId = new URL(start.headers.location!, fixture.config.reachableAddress).searchParams.get("request")!;
  const noCsrf = await fixture.app.inject({ method: "POST", url: `/api/oauth/consent/${requestId}/approve`, headers: fixture.headers, payload: { companyId: fixture.company.id, projectIds: [fixture.project.id] } });
  expect(noCsrf.statusCode).toBe(403);
  fixture.database.authTransaction((db) => db.prepare("UPDATE suplex_users SET role = 'member' WHERE id = ?").run(fixture.userId));
  const nonAdmin = await fixture.app.inject({ method: "POST", url: `/api/oauth/consent/${requestId}/approve`, headers: csrfHeaders(fixture.headers), payload: { companyId: fixture.company.id, projectIds: [fixture.project.id] } });
  expect(nonAdmin.statusCode).toBe(403);
  fixture.database.authTransaction((db) => db.prepare("UPDATE suplex_users SET role = 'admin' WHERE id = ?").run(fixture.userId));

  fixture.database.authTransaction((db) => db.prepare("UPDATE suplex_oauth_access_tokens SET expires_at = ? WHERE token_hash = ?").run(new Date(0).toISOString(), createHash("sha256").update(token).digest("hex")));
  const expired = await fixture.app.inject({ method: "POST", url: "/mcp", headers: { host, authorization: `Bearer ${token}` }, payload: initialize });
  expect(expired.statusCode).toBe(401);
  expect(expired.headers["www-authenticate"]).toContain("resource_metadata");

  const freshCode = await authorize(fixture, client.client_id, verifier, "revoke-endpoint");
  const freshTokens = (await exchange(fixture, client.client_id, freshCode, verifier)).json() as { access_token: string };
  const revoked = await fixture.app.inject({ method: "POST", url: "/oauth/revoke", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ token: freshTokens.access_token, client_id: client.client_id }).toString() });
  expect(revoked.statusCode).toBe(200);
  const revokedAccess = await fixture.app.inject({ method: "POST", url: "/mcp", headers: { host, authorization: `Bearer ${freshTokens.access_token}` }, payload: initialize });
  expect(revokedAccess.statusCode).toBe(401);
});

test("two clients with the same display name remain isolated", async () => {
  const fixture = await nativeApp(); fixtures.push(fixture);
  const first = await register(fixture, "Claude");
  const second = await register(fixture, "Claude");
  const verifier = "n".repeat(43);
  await exchange(fixture, first.client_id, await authorize(fixture, first.client_id, verifier, "first"), verifier);
  await exchange(fixture, second.client_id, await authorize(fixture, second.client_id, verifier, "second"), verifier);
  const rows = fixture.database.authQuery((db) => db.prepare("SELECT g.client_id, g.agent_id, a.name FROM suplex_oauth_grants g JOIN suplex_agents a ON a.id = g.agent_id ORDER BY g.client_id").all() as Array<{ client_id: string; agent_id: string; name: string }>);
  expect(new Set(rows.map(({ agent_id }) => agent_id)).size).toBe(2);
  expect(new Set(rows.map(({ name }) => name)).size).toBe(2);
});

test("dynamic registration throttles one source without blocking another source", async () => {
  const fixture = await nativeApp(); fixtures.push(fixture);
  const payload = { client_name: "Rate test", redirect_uris: ["http://127.0.0.1:9317/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  for (let index = 0; index < 20; index += 1) {
    expect((await fixture.app.inject({ method: "POST", url: "/oauth/register", remoteAddress: "192.0.2.1", payload })).statusCode).toBe(201);
  }
  expect((await fixture.app.inject({ method: "POST", url: "/oauth/register", remoteAddress: "192.0.2.1", headers: { "x-forwarded-for": "192.0.2.2" }, payload })).statusCode).toBe(429);
  expect((await fixture.app.inject({ method: "POST", url: "/oauth/register", remoteAddress: "192.0.2.2", payload })).statusCode).toBe(201);
});
