import { expect, test } from "vitest";

import { OpenCodeClient, type OpenCodeFailure } from "../src/opencode-client.js";

const session = {
  id: "ses_test",
  projectID: "project",
  directory: "/tmp/forge-opencode",
  title: "Native session",
  version: "1.18.29",
  time: { created: 1, updated: 2 },
  model: { id: "gpt-5.6-luna", providerID: "openai", variant: "max" },
  agent: "forge-root",
};
const user = {
  id: "msg_user",
  sessionID: "ses_test",
  role: "user" as const,
  time: { created: 3 },
  agent: "forge-root",
  model: { providerID: "openai", modelID: "gpt-5.6-luna" },
};
const assistant = {
  id: "msg_assistant",
  sessionID: "ses_test",
  role: "assistant" as const,
  time: { created: 4, completed: 5 },
  parentID: "msg_user",
  modelID: "gpt-5.6-luna",
  providerID: "openai",
  mode: "build",
  agent: "forge-root",
  path: { cwd: "/tmp/forge-opencode", root: "/tmp/forge-opencode" },
  cost: 0,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  variant: "max",
  finish: "stop",
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("provider observations strip credentials and configuration secrets", async () => {
  const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:43123", password: "test-password", fetch: async (input, init) => {
    const request = new Request(input, init);
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe("/provider");
    expect(new URL(request.url).searchParams.get("directory")).toBe("/tmp/providers");
    return jsonResponse({ all: [{ id: "openai", name: "OpenAI", key: "secret-key", options: { apiKey: "secret-option" }, models: { luna: { id: "luna", name: "Luna", options: { apiKey: "model-secret" } } } }], connected: ["openai"], default: { openai: "luna" } });
  } });
  expect(await client.providers("/tmp/providers")).toEqual({ all: [{ id: "openai", name: "OpenAI", models: { luna: { id: "luna", name: "Luna" } } }], connected: ["openai"], default: { openai: "luna" } });
});

test("abort targets the native session without deleting its history", async () => {
  const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:43123", password: "test-password", fetch: async (input, init) => {
    const request = new Request(input, init);
    expect(request.method).toBe("POST");
    expect(request.body).toBeNull();
    expect(new URL(request.url).pathname).toBe("/session/ses_test/abort");
    expect(new URL(request.url).searchParams.get("directory")).toBe("/tmp/task");
    return jsonResponse(true);
  } });
  await expect(client.abortSession("ses_test", "/tmp/task")).resolves.toBe(true);
});

test("MCP discovery uses a bodyless GET scoped to the session directory", async () => {
  const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:43123", password: "test-password", fetch: async (input, init) => {
    const request = new Request(input, init);
    expect(request.method).toBe("GET");
    expect(request.body).toBeNull();
    expect(new URL(request.url).searchParams.get("directory")).toBe("/tmp/forge-opencode");
    return jsonResponse({ forge_root: { status: "connected" } });
  } });
  await expect(client.mcpStatus("/tmp/forge-opencode")).resolves.toEqual({ forge_root: { status: "connected" } });
});

test("client uses the installed v1 routes and validates native envelopes", async () => {
  const calls: Array<{ url: string; method: string; redirect: RequestRedirect; body?: unknown }> = [];
  const client = new OpenCodeClient({
    baseUrl: "http://127.0.0.1:43123",
    username: "opencode",
    password: "test-password",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push({
        url: request.url,
        method: request.method,
        redirect: request.redirect,
        ...(request.body ? { body: await request.json() } : {}),
      });
      if (request.url.endsWith("/global/health")) return jsonResponse({ healthy: true, version: "1.18.29" });
      if (request.url.endsWith("/config?directory=%2Ftmp%2Fforge-opencode")) return jsonResponse({ model: "openai/gpt-5.6-luna" });
      if (request.url.endsWith("/session?directory=%2Ftmp%2Fforge-opencode")) return jsonResponse(session);
      if (request.url.endsWith("/session/ses_test?directory=%2Ftmp%2Fforge-opencode")) return jsonResponse(session);
      if (request.url.endsWith("/session/ses_test/message?directory=%2Ftmp%2Fforge-opencode")) return jsonResponse([{ info: user, parts: [{ type: "text", text: "Inspect the task." }] }, { info: assistant, parts: [{ type: "text", text: "done" }] }]);
      if (request.url.endsWith("/session/status?directory=%2Ftmp%2Fforge-opencode")) return jsonResponse({ ses_test: { type: "idle" } });
      if (request.url.endsWith("/session/ses_test/prompt_async?directory=%2Ftmp%2Fforge-opencode")) return new Response(null, { status: 204 });
      throw new Error(`unexpected route ${request.url}`);
    },
  });

  await expect(client.health()).resolves.toEqual({ healthy: true, version: "1.18.29" });
  await expect(client.getConfig("/tmp/forge-opencode")).resolves.toEqual({ model: "openai/gpt-5.6-luna" });
  await expect(client.createSession({
    title: "Native session",
    directory: "/tmp/forge-opencode",
    model: { id: "gpt-5.6-luna", providerID: "openai", variant: "max" },
    agent: "forge-root",
  })).resolves.toMatchObject({ id: "ses_test" });
  await expect(client.getSession("ses_test", "/tmp/forge-opencode")).resolves.toMatchObject({ id: "ses_test" });
  await expect(client.getMessages("ses_test", { directory: "/tmp/forge-opencode" })).resolves.toHaveLength(2);
  await expect(client.getStatus("/tmp/forge-opencode")).resolves.toEqual({ ses_test: { type: "idle" } });
  await expect(client.promptAsync({
    sessionID: "ses_test",
    messageID: "msg_retry",
    directory: "/tmp/forge-opencode",
    model: { providerID: "openai", modelID: "gpt-5.6-luna" },
    agent: "forge-root",
    variant: "max",
    text: "Inspect the task.",
  })).resolves.toBeUndefined();

  expect(calls.map(({ url, method }) => `${method} ${new URL(url).pathname}`)).toEqual([
    "GET /global/health",
    "GET /config",
    "POST /session",
    "GET /session/ses_test",
    "GET /session/ses_test/message",
    "GET /session/status",
    "POST /session/ses_test/prompt_async",
  ]);
  expect(calls.every(({ redirect }) => redirect === "error")).toBe(true);
  expect(calls[2]?.body).toEqual({
    title: "Native session",
    agent: "forge-root",
    model: { id: "gpt-5.6-luna", providerID: "openai", variant: "max" },
  });
  expect(calls[6]?.body).toEqual({
    messageID: "msg_retry",
    model: { providerID: "openai", modelID: "gpt-5.6-luna" },
    agent: "forge-root",
    variant: "max",
    parts: [{ type: "text", text: "Inspect the task." }],
  });
});

test("client authenticates loopback requests without exposing response bodies on failures", async () => {
  let authorization = "";
  const client = new OpenCodeClient({
    baseUrl: "http://localhost:43123/",
    username: "opencode",
    password: "test-password",
    fetch: async (input, init) => {
      authorization = new Request(input, init).headers.get("authorization") ?? "";
      return jsonResponse({ secret: "must-not-become-error-text" }, 503);
    },
  });

  await expect(client.health()).rejects.toEqual(expect.objectContaining<Partial<OpenCodeFailure>>({
    code: "server_unavailable",
    retryable: true,
    status: 503,
  }));
  expect(authorization.startsWith("Basic ")).toBe(true);
  expect(Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8")).toBe("opencode:test-password");
  await expect(client.health()).rejects.not.toThrow("must-not-become-error-text");
});

test("client fails closed for invalid addresses, malformed native data, and non-204 async acknowledgements", async () => {
  expect(() => new OpenCodeClient({ baseUrl: "https://example.com", password: "secret" })).toThrow("loopback");
  const malformed = new OpenCodeClient({ baseUrl: "http://127.0.0.1:43123", password: "secret", fetch: async () => jsonResponse({ healthy: false, version: "1.18.29" }) });
  await expect(malformed.health()).rejects.toMatchObject({ code: "invalid_response", retryable: false });

  const wrongStatus = new OpenCodeClient({ baseUrl: "http://127.0.0.1:43123", password: "secret", fetch: async () => jsonResponse({}, 200) });
  await expect(wrongStatus.promptAsync({
    sessionID: "ses_test",
    messageID: "msg_retry",
    model: { providerID: "openai", modelID: "gpt-5.6-luna" },
    agent: "forge-root",
    variant: "max",
    text: "Inspect the task.",
  })).rejects.toMatchObject({ code: "unexpected_status", status: 200 });
});
