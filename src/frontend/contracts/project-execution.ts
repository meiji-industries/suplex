import { z } from "zod";

import { ProjectMcpSchema } from "./project-mcp.js";

export const ProjectExecutionSchema = z.object({
  instructions: z.string().default(""),
  skillDirectories: z.array(z.string().min(1)).max(50).default([]),
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine(key => !/^(?:HOME|PATH|CLAUDE|ANTHROPIC|AWS|GOOGLE|AZURE|SUPLEX)_?/.test(key), "Provider routing variables are not project environment values"), z.string()).default({}),
  mcp: ProjectMcpSchema.default([]),
}).strict();

export type ProjectExecution = z.infer<typeof ProjectExecutionSchema>;
