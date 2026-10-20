// Connection instructions for common MCP clients. Each snippet comes from the client's official documentation.
// Suplex serves Streamable HTTP with OAuth 2.1 and dynamic client registration, so every client needs only the URL.

export type McpClientGroup = "Terminal agents" | "Editors" | "Desktop and web" | "Other";
export type McpSnippetFormat = "shell" | "json" | "toml" | "yaml" | "url";

export type McpClient = {
  id: string;
  label: string;
  group: McpClientGroup;
  description: string;
  format: McpSnippetFormat;
  render: (mcpUrl: string) => string;
  docsUrl?: string;
};

export const MCP_CLIENT_GROUPS: readonly McpClientGroup[] = ["Terminal agents", "Editors", "Desktop and web", "Other"];

const json = (value: unknown): string => JSON.stringify(value, null, 2);
const mcpServers = (server: Record<string, string>): string => json({ mcpServers: { suplex: server } });

export const MCP_CLIENTS: readonly McpClient[] = [
  {
    id: "claude-code", label: "Claude Code", group: "Terminal agents", format: "shell",
    description: "Run these commands. You can also run /mcp in Claude Code and select Authenticate.",
    render: (url) => `claude mcp add --transport http suplex ${url}\nclaude mcp login suplex`,
    docsUrl: "https://code.claude.com/docs/en/mcp",
  },
  {
    id: "codex", label: "Codex", group: "Terminal agents", format: "shell",
    description: "Run these commands. Codex opens the browser for OAuth.",
    render: (url) => `codex mcp add suplex --url ${url}\ncodex mcp login suplex`,
    docsUrl: "https://learn.chatgpt.com/docs/extend/mcp",
  },
  {
    id: "gemini-cli", label: "Gemini CLI", group: "Terminal agents", format: "shell",
    description: "Run this command. Then run /mcp auth suplex in Gemini CLI to start OAuth.",
    render: (url) => `gemini mcp add --transport http suplex ${url}`,
    docsUrl: "https://geminicli.com/docs/tools/mcp-server/",
  },
  {
    id: "copilot-cli", label: "GitHub Copilot CLI", group: "Terminal agents", format: "shell",
    description: "Run this command. Copilot CLI saves the server in ~/.copilot/mcp-config.json. You can also run /mcp add in a session.",
    render: (url) => `copilot mcp add --transport http suplex ${url}`,
    docsUrl: "https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli",
  },
  {
    id: "opencode", label: "OpenCode", group: "Terminal agents", format: "json",
    description: "Add this server to opencode.json. Then run opencode mcp auth suplex to start OAuth.",
    render: (url) => json({ $schema: "https://opencode.ai/config.json", mcp: { suplex: { type: "remote", url } } }),
    docsUrl: "https://opencode.ai/docs/mcp-servers/",
  },
  {
    id: "amp", label: "Amp", group: "Terminal agents", format: "shell",
    description: "Run this command. Amp opens the browser for OAuth when it starts.",
    render: (url) => `amp mcp add suplex ${url}`,
    docsUrl: "https://ampcode.com/docs/customize/mcp",
  },
  {
    id: "goose", label: "Goose", group: "Terminal agents", format: "yaml",
    description: "Add this extension to ~/.config/goose/config.yaml. You can also run goose configure and select Remote Extension (Streamable HTTP).",
    render: (url) => `extensions:\n  suplex:\n    name: Suplex\n    type: streamable_http\n    uri: ${url}\n    enabled: true\n    timeout: 300`,
    docsUrl: "https://goose-docs.ai/docs/getting-started/using-extensions",
  },
  {
    id: "cursor", label: "Cursor", group: "Editors", format: "json",
    description: "Add this server to .cursor/mcp.json in the project or to ~/.cursor/mcp.json. Cursor shows a login action for OAuth.",
    render: (url) => mcpServers({ url }),
    docsUrl: "https://cursor.com/docs/context/mcp",
  },
  {
    id: "vscode", label: "VS Code", group: "Editors", format: "shell",
    description: "Run this command. You can also add the server to .vscode/mcp.json. VS Code opens the browser for OAuth.",
    render: (url) => `code --add-mcp '${JSON.stringify({ name: "suplex", type: "http", url })}'`,
    docsUrl: "https://code.visualstudio.com/docs/agents/reference/mcp-configuration",
  },
  {
    id: "windsurf", label: "Windsurf (Devin Desktop)", group: "Editors", format: "json",
    description: "Add this server to mcp_config.json. Open the file from the MCP settings in Devin Desktop or Windsurf.",
    render: (url) => mcpServers({ serverUrl: url }),
    docsUrl: "https://docs.devin.ai/desktop/cascade/mcp",
  },
  {
    id: "zed", label: "Zed", group: "Editors", format: "json",
    description: "Add this server to the Zed settings.json. Zed asks you to authenticate with OAuth.",
    render: (url) => json({ context_servers: { suplex: { url } } }),
    docsUrl: "https://zed.dev/docs/ai/mcp",
  },
  {
    id: "jetbrains", label: "JetBrains AI Assistant", group: "Editors", format: "json",
    description: "Open Settings > Tools > AI Assistant > Model Context Protocol (MCP). Select Add and add this JSON.",
    render: (url) => mcpServers({ url }),
    docsUrl: "https://www.jetbrains.com/help/ai-assistant/mcp.html",
  },
  {
    id: "cline", label: "Cline", group: "Editors", format: "json",
    description: "Add this server to cline_mcp_settings.json. Keep the streamableHttp type, because Cline uses SSE when the type is not set.",
    render: (url) => mcpServers({ type: "streamableHttp", url }),
    docsUrl: "https://docs.cline.bot/mcp/configuring-mcp-servers",
  },
  {
    id: "roo-code", label: "Roo Code", group: "Editors", format: "json",
    description: "Add this server to .roo/mcp.json in the project or to the global mcp_settings.json.",
    render: (url) => mcpServers({ type: "streamable-http", url }),
    docsUrl: "https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo",
  },
  {
    id: "kiro", label: "Kiro", group: "Editors", format: "json",
    description: "Add this server to .kiro/settings/mcp.json or ~/.kiro/settings/mcp.json. Kiro opens the browser for OAuth.",
    render: (url) => mcpServers({ url }),
    docsUrl: "https://kiro.dev/docs/mcp/configuration/",
  },
  {
    id: "claude-desktop", label: "Claude Desktop", group: "Desktop and web", format: "url",
    description: "Open Settings > Connectors. Select Add custom connector and add this URL. Claude can connect only to a reachable HTTPS address.",
    render: (url) => url,
    docsUrl: "https://claude.com/docs/connectors/custom/add-unlisted",
  },
  {
    id: "chatgpt", label: "ChatGPT", group: "Desktop and web", format: "url",
    description: "Turn on developer mode in Settings > Apps. Create an app with this URL. ChatGPT needs reachable HTTPS. Suplex has not tested ChatGPT.",
    render: (url) => url,
  },
  {
    id: "warp", label: "Warp", group: "Desktop and web", format: "json",
    description: "Open the MCP servers page in Warp. Select Add and add this JSON.",
    render: (url) => mcpServers({ url }),
    docsUrl: "https://docs.warp.dev/knowledge-and-collaboration/mcp",
  },
  {
    id: "manual", label: "Any MCP client (manual)", group: "Other", format: "url",
    description: "Add this URL to a client that supports Streamable HTTP and OAuth 2.1 with dynamic client registration. Remote web clients need reachable HTTPS.",
    render: (url) => url,
  },
];

export const DEFAULT_MCP_CLIENT_ID = "claude-code";

export function mcpClient(id: string): McpClient {
  return MCP_CLIENTS.find((client) => client.id === id) ?? MCP_CLIENTS[0]!;
}
