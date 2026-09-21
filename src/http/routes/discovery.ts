import type { FastifyPluginAsync } from "fastify";

/**
 * Public machine-discovery artifacts. They describe how to reach the paired-agent
 * runtime; they never carry task data, credentials, or company state. Every entry
 * here must stay a statement about the contract, not an observation of it.
 */

const AUTHORIZATION = "Every runtime route needs a paired-agent bearer credential. An administrator issues a pairing code, and the agent exchanges it once at POST /api/hermes/pairing/exchange. The credential is scoped to one company and to the projects granted to that agent. Nothing below returns task data without it.";

const CATALOG = {
  service: "Forge",
  summary: "Forge runs coordinated coding agents against your repositories. Paired agents read and create tasks over an authenticated HTTP API.",
  authorization: AUTHORIZATION,
  discovery: [
    { path: "/llms.txt", method: "GET", authentication: "none", description: "Plain-text overview of this deployment for machine readers." },
    { path: "/.well-known/forge/api-catalog.json", method: "GET", authentication: "none", description: "This catalog." },
    { path: "/.well-known/forge/agent-skills.json", method: "GET", authentication: "none", description: "Agent skill and client discovery index." },
  ],
  pairing: [
    { path: "/api/hermes/pairing/exchange", method: "POST", authentication: "pairing code", description: "Exchange a one-time pairing code for a scoped agent credential. The code is single use." },
  ],
  runtime: [
    { path: "/api/hermes/openapi.json", method: "GET", authentication: "agent credential", description: "The authoritative OpenAPI 3.0.3 contract for the runtime routes. Read it after pairing." },
    { path: "/api/hermes/capabilities", method: "GET", authentication: "agent credential", description: "The commands this deployment accepts and the commands it does not." },
    { path: "/api/hermes/me", method: "GET", authentication: "agent credential", description: "The agent identity and the projects granted to it." },
    { path: "/api/hermes/workflows", method: "GET", authentication: "agent credential", description: "List workflow records for a granted project and whether task creation permits each one." },
    { path: "/api/hermes/templates", method: "GET", authentication: "agent credential", description: "List task templates for a granted project and whether task creation permits each one." },
    { path: "/api/hermes/tasks", method: "GET", authentication: "agent credential", description: "List the tasks this agent created." },
    { path: "/api/hermes/tasks", method: "POST", authentication: "agent credential", description: "Create a backlog task, or a queued task with queue true. An idempotency key is necessary. A queued task starts by itself only when every prerequisite is complete." },
    { path: "/api/hermes/tasks/{taskId}", method: "GET", authentication: "agent credential", description: "Read one task. Send the ETag in If-None-Match to poll conditionally." },
    { path: "/api/hermes/tasks/{taskId}/dependencies", method: "PUT", authentication: "agent credential", description: "Replace the prerequisites of a task, shown as Blocked by." },
    { path: "/api/hermes/tasks/{taskId}/commands", method: "POST", authentication: "agent credential", description: "Apply one lifecycle command with the current revision and an idempotency key. start_task queues a task and disarm_task returns it to the manual backlog." },
  ],
  administration: {
    description: "Pairing codes, credential rotation, revocation, and project grants live under /api/admin/hermes-agents. An administrator session controls them. They are not part of the agent runtime contract.",
  },
  notes: [
    "Forge conceals tasks that the caller cannot read. Denied and missing tasks both answer 404 with resource_not_found.",
    "Human answers, delivery, and merges stay human authority unless the deployment reports them in /api/hermes/capabilities.",
  ],
  documentation: {
    discovery: "docs/agents/machine-discovery.md",
    runtimeApi: "docs/hermes-agent-api.md",
    mcpBridge: "docs/hermes-mcp-bridge.md",
    skill: "docs/hermes-skill.md",
  },
} as const;

const SKILLS = {
  authorization: AUTHORIZATION,
  skills: [
    {
      name: "forge",
      summary: "Work with Forge tasks as a paired agent: discover capabilities, projects, workflows, and templates; create backlog tasks idempotently; set their prerequisites; poll them; and send lifecycle commands.",
      source: "hermes/skills/forge",
      instructions: "hermes/skills/forge/SKILL.md",
      install: "docs/hermes-skill.md",
      clients: [
        {
          transport: "mcp-stdio",
          preferred: true,
          command: "forge mcp",
          server: "forge-hermes-bridge",
          tools: ["forge_whoami", "forge_capabilities", "forge_list_workflows", "forge_list_templates", "forge_list_tasks", "forge_get_task", "forge_get_task_delivery", "forge_create_task", "forge_set_task_dependencies", "forge_command_task"],
          description: "A local stdio MCP server that maps the runtime routes onto typed tools. Forge serves no remote MCP endpoint.",
          documentation: "docs/hermes-mcp-bridge.md",
        },
        {
          transport: "http-bearer",
          preferred: false,
          client: "hermes/skills/forge/forge_client.py",
          description: "A standard-library Python client over the same routes. Use it when no MCP bridge is registered.",
          documentation: "docs/hermes-agent-api.md",
        },
      ],
      environment: [
        { name: "FORGE_BASE_URL", description: "The Forge origin." },
        { name: "FORGE_AGENT_CREDENTIAL", description: "The credential from the pairing exchange. Keep it in the profile .env file. Never pass it on a command line." },
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
    "Read /api/hermes/openapi.json after pairing. That document is authoritative; this file is a map.",
    "",
    ...CATALOG.runtime.map(line),
    "",
    "## Clients",
    "",
    "- MCP: run the local stdio bridge with `forge mcp`. Forge serves no remote MCP endpoint.",
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

const discovery: FastifyPluginAsync = async (app) => {
  const text = overview();
  app.get("/llms.txt", async (_request, reply) => reply.type("text/plain; charset=utf-8").header("Cache-Control", "public, max-age=300").send(text));
  app.get("/.well-known/forge/api-catalog.json", async (_request, reply) => reply.type("application/json; charset=utf-8").header("Cache-Control", "public, max-age=300").send(CATALOG));
  app.get("/.well-known/forge/agent-skills.json", async (_request, reply) => reply.type("application/json; charset=utf-8").header("Cache-Control", "public, max-age=300").send(SKILLS));
};

export const DISCOVERY_ARTIFACT_PATHS = ["/llms.txt", "/.well-known/forge/api-catalog.json", "/.well-known/forge/agent-skills.json"] as const;

export default discovery;
