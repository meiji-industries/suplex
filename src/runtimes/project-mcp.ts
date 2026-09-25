import type { ProjectMcp } from "./project-mcp-contracts.js";
export { ProjectMcpSchema } from "./project-mcp-contracts.js";
export type { ProjectMcp } from "./project-mcp-contracts.js";

export function projectMcpTools(servers: ProjectMcp = [], role: "root" | "advisor" | "worker"): string[] {
  return servers.flatMap(server => server.grants[role].map(tool => `mcp__${server.name}__${tool}`));
}

export function projectMcpServers(servers: ProjectMcp = [], role: "root" | "advisor" | "worker", environment: NodeJS.ProcessEnv = process.env) {
  const resolve = (references: Record<string, string>) => Object.fromEntries(Object.entries(references).map(([key, reference]) => {
    const value = environment[reference];
    if (!value) throw new Error(`MCP credential environment variable ${reference} is not configured`);
    return [key, value];
  }));
  return Object.fromEntries(servers.filter(server => server.grants[role].length > 0).map(server => [server.name,
    server.transport.type === "stdio"
      ? { type: "stdio", command: server.transport.command, args: server.transport.args, env: resolve(server.transport.env) }
      : { type: "http", url: server.transport.url, headers: resolve(server.transport.headers) },
  ]));
}
