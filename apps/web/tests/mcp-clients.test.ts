import { expect, test } from "vitest";

import { DEFAULT_MCP_CLIENT_ID, MCP_CLIENT_GROUPS, MCP_CLIENTS, mcpClient } from "../features/admin/mcp-clients.js";

const mcpUrl = "https://suplex.example.com/mcp";

test("every client renders a snippet with the canonical MCP address", () => {
  for (const client of MCP_CLIENTS) expect(client.render(mcpUrl), client.id).toContain(mcpUrl);
});

test("JSON snippets parse and carry the address as a value", () => {
  for (const client of MCP_CLIENTS.filter((entry) => entry.format === "json")) {
    expect(JSON.stringify(JSON.parse(client.render(mcpUrl))), client.id).toContain(`"${mcpUrl}"`);
  }
});

test("client ids are unique and every client belongs to a listed group", () => {
  expect(new Set(MCP_CLIENTS.map((client) => client.id)).size).toBe(MCP_CLIENTS.length);
  for (const client of MCP_CLIENTS) expect(MCP_CLIENT_GROUPS).toContain(client.group);
});

test("Claude Code is first and default, and Codex is second", () => {
  expect(MCP_CLIENTS[0]?.id).toBe("claude-code");
  expect(DEFAULT_MCP_CLIENT_ID).toBe("claude-code");
  expect(MCP_CLIENTS[1]?.id).toBe("codex");
  expect(mcpClient("unknown").id).toBe("claude-code");
});

test("the catalog lists the common clients in group order", () => {
  expect(MCP_CLIENTS.map((client) => client.label)).toEqual([
    "Claude Code", "Codex", "Gemini CLI", "GitHub Copilot CLI", "OpenCode", "Amp", "Goose",
    "Cursor", "VS Code", "Windsurf (Devin Desktop)", "Zed", "JetBrains AI Assistant", "Cline", "Roo Code", "Kiro",
    "Claude Desktop", "ChatGPT", "Warp",
    "Any MCP client (manual)",
  ]);
  const groupOrder = MCP_CLIENTS.map((client) => MCP_CLIENT_GROUPS.indexOf(client.group));
  expect(groupOrder).toEqual([...groupOrder].sort((a, b) => a - b));
});

test("client descriptions follow the 25-word limit for UI descriptions", () => {
  for (const client of MCP_CLIENTS) expect(client.description.split(/\s+/).length, client.id).toBeLessThanOrEqual(25);
});

test("command snippets match the documented syntax", () => {
  expect(mcpClient("claude-code").render(mcpUrl)).toBe(`claude mcp add --transport http suplex ${mcpUrl}\nclaude mcp login suplex`);
  expect(mcpClient("codex").render(mcpUrl)).toBe(`codex mcp add suplex --url ${mcpUrl}\ncodex mcp login suplex`);
  expect(mcpClient("vscode").render(mcpUrl)).toBe(`code --add-mcp '{"name":"suplex","type":"http","url":"${mcpUrl}"}'`);
  expect(JSON.parse(mcpClient("cline").render(mcpUrl))).toEqual({ mcpServers: { suplex: { type: "streamableHttp", url: mcpUrl } } });
  expect(JSON.parse(mcpClient("windsurf").render(mcpUrl))).toEqual({ mcpServers: { suplex: { serverUrl: mcpUrl } } });
});
