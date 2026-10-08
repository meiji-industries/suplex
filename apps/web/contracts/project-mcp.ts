import { z } from "zod";

const toolName = z.string().regex(/^[A-Za-z0-9_-]+$/);

const environmentReference = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const ProjectMcpSchema = z.array(z.object({
  name: toolName.refine(name => !name.startsWith("suplex_"), "Suplex server names are reserved"),
  transport: z.discriminatedUnion("type", [
    z.object({ type: z.literal("stdio"), command: z.string().min(1), args: z.array(z.string()).default([]), env: z.record(z.string(), environmentReference).default({}) }),
    z.object({ type: z.literal("http"), url: z.string().url(), headers: z.record(z.string(), environmentReference).default({}) }),
  ]),
  grants: z.object({ root: z.array(toolName), advisor: z.array(toolName), worker: z.array(toolName) }),
})).refine(servers => new Set(servers.map(server => server.name)).size === servers.length, "MCP server names must be unique");
