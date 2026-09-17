import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { afterEach, expect, test, vi } from "vitest";
import WebSocket from "ws";

import type { AuthUser } from "../src/identity/auth.js";
import providerLogin from "../src/http/routes/provider-login.js";
import type { BridgeEvent } from "../src/integrations/herdr/terminal-bridge.js";
import * as executables from "../src/platform/executable-resolver.js";
import { providerLoginCommand } from "../src/profiles/provider-login.js";

afterEach(() => vi.restoreAllMocks());

test("providerLoginCommand embeds the resolved executable and falls back to the binary name", async () => {
  vi.spyOn(executables, "resolveClaudeExecutable").mockResolvedValue("/opt/claude cli/claude");
  vi.spyOn(executables, "resolveDevinExecutable").mockResolvedValue("/opt/devin/devin");
  vi.spyOn(executables, "resolveCodexExecutable").mockResolvedValue("/opt/codex/codex");
  vi.spyOn(executables, "resolveOpenCodeExecutable").mockRejectedValue(new Error("missing"));

  expect(await providerLoginCommand("claude-code")).toBe("'/opt/claude cli/claude' auth login");
  expect(await providerLoginCommand("claude-code", "/home/work laptop")).toContain("CLAUDE_CONFIG_DIR='/home/work laptop' ANTHROPIC_CONFIG_DIR='/home/work laptop/anthropic' '/opt/claude cli/claude' auth login --setting-sources ''");
  expect(await providerLoginCommand("devin")).toBe("'/opt/devin/devin' auth login");
  expect(await providerLoginCommand("codex")).toBe("'/opt/codex/codex' login");
  expect(await providerLoginCommand("opencode")).toBe("opencode auth login");
  expect(await providerLoginCommand("opencode", null, { resolveExecutable: async () => "/opt/opencode/opencode" })).toBe("'/opt/opencode/opencode' auth login");
});

test("provider login terminal is admin-only, validates the pane, and bridges control input", async () => {
  const app = Fastify();
  const clients: WebSocket[] = [];
  try {
    const panes = new Map<string, { paneId: string }>();
    let paneSeq = 0;
    const herdr = {
      getPane: async (id: string) => panes.get(id) ?? null,
      createWorkspace: async () => {
        const pane = { paneId: `pane-login-${++paneSeq}` };
        panes.set(pane.paneId, pane);
        return { workspace: { workspaceId: `ws-login-${paneSeq}`, label: "forge-provider-login" }, tab: { tabId: `tab-${paneSeq}`, label: "sign-in" }, rootPane: pane };
      },
      runPaneCommand: vi.fn(async () => {}),
      closePane: vi.fn(async () => {}),
      closeWorkspace: vi.fn(async () => {}),
    };
    const user: AuthUser = { id: "admin-1", displayName: "Admin", username: "admin@forge.local", avatarSeed: "admin", role: "admin", status: "active", companyIds: [] };
    await app.register(websocket);
    app.decorateRequest("forgeUser", { getter: () => user });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const bridge = { input: vi.fn(), resize: vi.fn(), scroll: vi.fn(), release: vi.fn() };
    const openBridge = vi.fn((options: { paneId: string; mode?: string; onEvent: (event: BridgeEvent) => void }) => ({ ...bridge, emit: options.onEvent }));
    const loginCommand = vi.fn(async (providerId: string, homeDirectory?: string | null) => homeDirectory ? `CLAUDE_CONFIG_DIR='${homeDirectory}' ${providerId} auth login` : `${providerId} auth login`);
    await app.register(providerLogin, { herdr, auth: { getUserForAuthority: () => user } as never, config: { reachableAddress: "http://127.0.0.1:4111" } as never, openBridge: openBridge as never, loginCommand });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const started = await app.inject({ method: "POST", url: "/api/admin/providers/claude-code/login" });
    expect(started.statusCode, started.body).toBe(200);
    const paneId = started.json().paneId as string;
    expect(loginCommand).toHaveBeenCalledWith("claude-code");
    expect(herdr.runPaneCommand).toHaveBeenCalledWith(paneId, "claude-code auth login");

    const wsBase = address.replace("http", "ws");
    const connect = (path: string, headers?: Record<string, string>) => {
      const socket = new WebSocket(`${wsBase}${path}`, headers ? { headers } : undefined);
      clients.push(socket);
      return socket;
    };
    const closeCode = (socket: WebSocket) => new Promise<number>(resolve => socket.once("close", code => resolve(code)));

    expect(await closeCode(connect("/api/admin/provider-login/pane-unknown/terminal"))).toBe(4404);
    expect(await closeCode(connect(`/api/admin/provider-login/${paneId}/terminal`, { origin: "https://evil.example" }))).toBe(4403);
    user.role = "member";
    expect(await closeCode(connect(`/api/admin/provider-login/${paneId}/terminal`))).toBe(4403);
    user.role = "admin";

    const client = connect(`/api/admin/provider-login/${paneId}/terminal?cols=100&rows=30`);
    const messages: string[] = [];
    client.on("message", data => messages.push(data.toString()));
    await new Promise<void>((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
    await vi.waitFor(() => expect(openBridge).toHaveBeenCalledOnce());
    expect(openBridge.mock.calls[0]![0]).toMatchObject({ paneId, mode: "control" });
    await vi.waitFor(() => expect(messages.some(message => message.includes('"type":"open"'))).toBe(true));
    expect(JSON.parse(messages.find(message => message.includes('"type":"open"'))!)).toMatchObject({ type: "open", paneId, readOnly: false });
    client.send(Buffer.from("yes\n"));
    client.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    client.send(JSON.stringify({ type: "scroll", direction: "up", lines: 5 }));
    await vi.waitFor(() => expect(bridge.input).toHaveBeenCalledWith(Buffer.from("yes\n")));
    expect(bridge.resize).toHaveBeenCalledWith(120, 40);
    expect(bridge.scroll).toHaveBeenCalledWith("up", 5);

    const closed = closeCode(client);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/provider-login/${paneId}` })).statusCode).toBe(204);
    expect(await closed).toBe(4404);
    await vi.waitFor(() => expect(bridge.release).toHaveBeenCalledOnce());
  } finally { for (const client of clients) client.terminate(); await app.close(); }
});
