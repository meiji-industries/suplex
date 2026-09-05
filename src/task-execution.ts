import { dirname, join } from "node:path";
import { z } from "zod";
import { OpenCodeClient } from "./opencode-client.js";
import { OpenCodeToolPartSchema, type OpenCodeMessageEnvelope } from "./opencode-contracts.js";
import { readOpenCodeServer } from "./opencode-server.js";
import type { TaskSession } from "./task-control.js";
import { TaskPlanItemSchema, type TaskExecution } from "./task-execution-contracts.js";

const messageLimit = 100;
const ToolDetailsSchema = z.object({
  input: z.record(z.string(), z.unknown()).default({}),
  output: z.string().optional(),
  error: z.string().optional(),
});
const PlanInputSchema = z.object({ todos: z.array(TaskPlanItemSchema) });

export function executionFromMessages(messages: OpenCodeMessageEnvelope[]) {
  const tools: TaskExecution["sessions"][number]["tools"] = [];
  let plan: TaskExecution["sessions"][number]["plan"] = null;
  for (const message of [...messages].sort((a, b) => a.info.time.created - b.info.time.created)) {
    if (message.info.role !== "assistant") continue;
    for (const part of message.parts) {
      const parsed = OpenCodeToolPartSchema.safeParse(part);
      if (!parsed.success) continue;
      const tool = parsed.data;
      const details = ToolDetailsSchema.parse(tool.state);
      tools.push({ id: `${message.info.id}:${tool.callID}`, name: tool.tool, status: tool.state.status, input: details.input, output: details.output ?? null, error: details.error ?? null });
      if (tool.tool === "todowrite" && tool.state.status === "completed") {
        const input = PlanInputSchema.safeParse(details.input);
        if (input.success) plan = input.data.todos;
      }
    }
  }
  return { tools, plan };
}

async function observeMessages(databasePath: string, session: TaskSession) {
  const server = await readOpenCodeServer(join(dirname(databasePath), "runtime", "task-sessions", session.id));
  if (!server || !session.nativeSessionId) throw new Error("Session is not available");
  const client = new OpenCodeClient({ baseUrl: server.baseUrl, password: server.password, timeoutMs: 2000 });
  return client.getMessages(session.nativeSessionId, { directory: server.directory, limit: messageLimit });
}

export async function readTaskExecution(databasePath: string, sessions: TaskSession[], observe = observeMessages): Promise<TaskExecution> {
  return { sessions: await Promise.all(sessions.filter(session => session.nativeSessionId).map(async session => {
    const identity = { id: session.id, role: session.kind, generation: session.generation };
    try {
      const messages = await observe(databasePath, session);
      return { ...identity, available: true, limited: messages.length >= messageLimit, ...executionFromMessages(messages) };
    } catch {
      return { ...identity, available: false, limited: false, tools: [], plan: null };
    }
  })) };
}
