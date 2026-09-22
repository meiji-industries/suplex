import type { FastifyPluginAsync } from "fastify";
import type { OAuthService } from "../../identity/oauth.js";
import { AGENT_API_MCP_AUTHORITY, AGENT_API_RUNTIME_AUTHORITY } from "../contracts/agent-api.js";

/**
 * Public machine-discovery artifacts. They describe how to reach the paired-agent
 * runtime; they never carry task data, credentials, or company state. Every entry
 * here must stay a statement about the contract, not an observation of it.
 */

const AUTHORIZATION = "The remote MCP endpoint uses OAuth 2.1 browser approval. The Agent API uses a paired-agent bearer credential. Both methods bind one external-agent identity to one company and its granted projects.";

const CATALOG = {
  service: "Forge",
  summary: "Forge runs coordinated coding agents against your repositories. External agents read and create tasks through OAuth MCP or the authenticated Agent API.",
  authorization: AUTHORIZATION,
  discovery: [
    { path: "/llms.txt", method: "GET", authentication: "none", description: "Plain-text overview of this deployment for machine readers." },
    { path: "/.well-known/forge/api-catalog.json", method: "GET", authentication: "none", description: "This catalog." },
    { path: "/.well-known/forge/agent-skills.json", method: "GET", authentication: "none", description: "Agent skill and client discovery index." },
    { path: "/.well-known/oauth-protected-resource/mcp", method: "GET", authentication: "none", description: "OAuth metadata for the MCP resource." },
    { path: "/.well-known/oauth-protected-resource", method: "GET", authentication: "none", description: "OAuth metadata for clients that use root discovery." },
    { path: "/.well-known/oauth-authorization-server", method: "GET", authentication: "none", description: "OAuth authorization server metadata." },
  ],
  pairing: [
    { path: "/api/agent/pairing/exchange", method: "POST", authentication: "pairing code", description: "Exchange a one-time pairing code for a scoped agent credential. The code is single use." },
  ],
  runtime: [
    { path: "/mcp", method: "POST", authentication: "OAuth bearer", description: "The Streamable HTTP MCP endpoint." },
    { path: "/api/agent/openapi.json", method: "GET", authentication: "agent credential", description: "The authoritative OpenAPI 3.0.3 contract for the runtime routes. Read it after pairing." },
    { path: "/api/agent/capabilities", method: "GET", authentication: "agent credential", description: "The commands this deployment accepts and the commands it does not." },
    { path: "/api/agent/me", method: "GET", authentication: "agent credential", description: "The agent identity and the projects granted to it." },
    { path: "/api/agent/workflows", method: "GET", authentication: "agent credential", description: "List workflow records for a granted project and whether task creation permits each one." },
    { path: "/api/agent/templates", method: "GET", authentication: "agent credential", description: "List task templates for a granted project and whether task creation permits each one." },
    { path: "/api/agent/tasks", method: "GET", authentication: "agent credential", description: "List tasks in the agent's currently granted projects. Filter by pull request number, source branch, or title substring. HTTP defaults to the full view; MCP forge_list_tasks defaults to summary and accepts view=full." },
    { path: "/api/agent/tasks", method: "POST", authentication: "agent credential", description: "Create a backlog task, or a queued task with queue true. An idempotency key is necessary. A queued task starts by itself only when every prerequisite is complete." },
    { path: "/api/agent/tasks/{taskId}", method: "GET", authentication: "agent credential", description: "Read one task. Send the ETag in If-None-Match to poll conditionally." },
    { path: "/api/agent/tasks/{taskId}/dependencies", method: "PUT", authentication: "agent credential", description: "Replace the prerequisites of a task, shown as Blocked by." },
    { path: "/api/agent/tasks/{taskId}/commands", method: "POST", authentication: "agent credential", description: "Apply one lifecycle command with the current revision and an idempotency key. start_task queues a task and disarm_task returns it to the manual backlog." },
  ],
  administration: {
    description: "OAuth connections, pairing codes, credential rotation, revocation, and project grants appear on the Agents page. An administrator controls them.",
  },
  notes: [
    "Forge conceals tasks that the caller cannot read. Denied and missing tasks both answer 404 with resource_not_found.",
    AGENT_API_RUNTIME_AUTHORITY,
    AGENT_API_MCP_AUTHORITY,
  ],
  documentation: {
    discovery: "docs/agents/machine-discovery.md",
    runtimeApi: "docs/agent-api.md",
    mcpBridge: "docs/agent-mcp.md",
    skill: "docs/agent-skill.md",
  },
} as const;

const SKILLS = {
  authorization: AUTHORIZATION,
  skills: [
    {
      name: "forge",
      summary: "Work with Forge tasks as a paired agent: discover capabilities, projects, workflows, and templates; create backlog tasks idempotently; set their prerequisites; poll them; and send lifecycle commands.",
      source: "skills/forge",
      instructions: "skills/forge/SKILL.md",
      install: "docs/agent-skill.md",
      clients: [
        {
          transport: "streamable-http",
          preferred: true,
          endpoint: "/mcp",
          authorization: "OAuth 2.1 authorization code with S256 PKCE",
          tools: ["forge_whoami", "forge_capabilities", "forge_list_workflows", "forge_list_templates", "forge_list_tasks", "forge_get_task", "forge_get_task_delivery", "forge_create_task", "forge_set_task_dependencies", "forge_command_task"],
          description: "The remote MCP endpoint uses browser sign-in and explicit project approval.",
          documentation: "docs/agent-mcp.md",
        },
        {
          transport: "mcp-stdio",
          preferred: false,
          command: "forge mcp",
          server: "forge-agent-bridge",
          tools: ["forge_whoami", "forge_capabilities", "forge_list_workflows", "forge_list_templates", "forge_list_tasks", "forge_get_task", "forge_get_task_delivery", "forge_create_task", "forge_set_task_dependencies", "forge_command_task"],
          description: "An advanced local bridge that uses a paired-agent credential.",
          documentation: "docs/agent-mcp.md",
        },
        {
          transport: "http-bearer",
          preferred: false,
          client: "skills/forge/forge_client.py",
          description: "A standard-library Python client over the same routes. Use it when no MCP bridge is registered.",
          documentation: "docs/agent-api.md",
        },
      ],
      environment: [
        { name: "FORGE_BASE_URL", description: "The Forge origin." },
        { name: "FORGE_AGENT_CREDENTIAL", description: "The credential from the pairing exchange. Set it in the client process environment. Never pass it on a command line." },
      ],
    },
  ],
} as const;

const overview = (): string => {
  const line = (entry: { method: string; path: string; authentication: string; description: string }): string =>
    `- ${entry.method} ${entry.path} (${entry.authentication}): ${entry.description}`;
  return [
    "# Forge",
    "",
    `> ${CATALOG.summary}`,
    "",
    "## Authorization",
    "",
    AUTHORIZATION,
    "",
    "## Public discovery",
    "",
    ...CATALOG.discovery.map(line),
    "",
    "## Pairing",
    "",
    ...CATALOG.pairing.map(line),
    "",
    "## Runtime API",
    "",
    "Read /api/agent/openapi.json after pairing. That document is authoritative; this file is a map.",
    "",
    ...CATALOG.runtime.map(line),
    "",
    "## Clients",
    "",
    "- MCP: connect a Streamable HTTP client to `/mcp` and complete OAuth browser approval.",
    "- MCP stdio: run the advanced local bridge with `forge mcp`.",
    "- HTTP: send `Authorization: Bearer <credential>` to the runtime routes.",
    "",
    "## Administration",
    "",
    CATALOG.administration.description,
    "",
    "## Notes",
    "",
    ...CATALOG.notes.map(note => `- ${note}`),
    "",
    "## Documentation",
    "",
    ...Object.values(CATALOG.documentation).map(path => `- ${path}`),
    "",
  ].join("\n");
};

const discovery: FastifyPluginAsync<{ oauth?: OAuthService }> = async (app, options) => {
  const text = overview();
  app.get("/llms.txt", async (_request, reply) => reply.type("text/plain; charset=utf-8").header("Cache-Control", "public, max-age=300").send(text));
  app.get("/.well-known/forge/api-catalog.json", async (_request, reply) => reply.type("application/json; charset=utf-8").header("Cache-Control", "public, max-age=300").send(CATALOG));
  app.get("/.well-known/forge/agent-skills.json", async (_request, reply) => reply.type("application/json; charset=utf-8").header("Cache-Control", "public, max-age=300").send(SKILLS));
  if (options.oauth) {
    const oauth = options.oauth;
    const protectedResource = { resource: oauth.resource, authorization_servers: [oauth.issuer], scopes_supported: ["forge:mcp"], bearer_methods_supported: ["header"] };
    const authorizationServer = { issuer: oauth.issuer, authorization_endpoint: `${oauth.issuer}/oauth/authorize`, token_endpoint: `${oauth.issuer}/oauth/token`, registration_endpoint: `${oauth.issuer}/oauth/register`, revocation_endpoint: `${oauth.issuer}/oauth/revoke`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["forge:mcp"], authorization_response_iss_parameter_supported: true };
    app.get("/.well-known/oauth-protected-resource/mcp", async (_request, reply) => reply.header("Cache-Control", "public, max-age=300").send(protectedResource));
    app.get("/.well-known/oauth-protected-resource", async (_request, reply) => reply.header("Cache-Control", "public, max-age=300").send(protectedResource));
    app.get("/.well-known/oauth-authorization-server", async (_request, reply) => reply.header("Cache-Control", "public, max-age=300").send(authorizationServer));
  }
};

export const DISCOVERY_ARTIFACT_PATHS = [
  "/llms.txt",
  "/.well-known/forge/api-catalog.json",
  "/.well-known/forge/agent-skills.json",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
] as const;

export default discovery;
