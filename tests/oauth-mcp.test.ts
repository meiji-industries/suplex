import { afterEach, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { nativeFixture } from "./helpers/native-browser.js";

const fixtures: Awaited<ReturnType<typeof nativeFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

test("official SDK discovers OAuth and calls Suplex tools without an agent key", async () => {
  const fixture = await nativeFixture(); fixtures.push(fixture);
  const origin = fixture.base;
  const uiTask = (await fixture.createTask({
    projectId: fixture.project.id,
    title: "Created through the Suplex UI",
    idempotencyKey: "oauth-visible-ui-task",
  }));
  expect((await fixture.api("POST", `/api/tasks/${uiTask.id}/start`)).status).toBe(200);

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

  fixture.database.prepare("UPDATE suplex_oauth_access_tokens SET expires_at = ?").run(new Date(0).toISOString());
  const reconnected = new Client({ name: "suplex-sdk-test", version: "1.0.0" });
  const refreshedTransport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider });
  await reconnected.connect(refreshedTransport as unknown as Transport);
  expect(await reconnected.listTools()).toMatchObject({ tools: expect.any(Array) });
  await reconnected.close();
});
