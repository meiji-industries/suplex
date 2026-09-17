import { z } from "zod";

const toolName = z.string().regex(/^[A-Za-z0-9_-]+$/);
const environmentReference = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const ProjectMcpSchema = z.array(z.object({
  name: toolName.refine(name => !name.startsWith("forge_"), "Forge server names are reserved"),
  transport: z.discriminatedUnion("type", [
    z.object({ type: z.literal("stdio"), command: z.string().min(1), args: z.array(z.string()).default([]), env: z.record(z.string(), environmentReference).default({}) }),
    z.object({ type: z.literal("http"), url: z.string().url(), headers: z.record(z.string(), environmentReference).default({}) }),
  ]),
  grants: z.object({ root: z.array(toolName), advisor: z.array(toolName), worker: z.array(toolName) }),
})).refine(servers => new Set(servers.map(server => server.name)).size === servers.length, "MCP server names must be unique");
export type ProjectMcp = z.infer<typeof ProjectMcpSchema>;

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
