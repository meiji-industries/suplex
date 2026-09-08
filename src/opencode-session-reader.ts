import { z } from "zod";
import { OpenCodeClient } from "./opencode-client.js";
import { OpenCodeToolPartSchema, type OpenCodeMessageEnvelope } from "./opencode-contracts.js";
import { openCodeServerClient, openCodeServerRunning, readOpenCodeServer, stopOpenCodeServer, type OpenCodeServerReference } from "./opencode-server.js";
import { openCodeDisplayAttached } from "./opencode-task-runtime.js";
import type { TaskSession } from "./task-control.js";
import { TaskPlanItemSchema, type TaskExecution } from "./task-execution-contracts.js";
import { taskSessionRuntimeDirectory, type NativeSessionReader } from "./task-harness.js";
import { taskUsage } from "./task-usage.js";
import { correlatedAssistants } from "./opencode-session.js";

const messageLimit = 100;
const ToolDetailsSchema = z.object({ input: z.record(z.string(), z.unknown()).default({}), output: z.string().optional(), error: z.string().optional() });
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

export class OpenCodeSessionReader implements NativeSessionReader {
  constructor(private readonly databasePath: string) {}

  private async connect(session: TaskSession): Promise<{ server: OpenCodeServerReference; client: OpenCodeClient; sessionID: string }> {
    const server = await readOpenCodeServer(taskSessionRuntimeDirectory(this.databasePath, session.id));
    if (!server || !session.nativeSessionId) throw new Error("Session is not available");
    return { server, client: new OpenCodeClient({ baseUrl: server.baseUrl, password: server.password, timeoutMs: 2000 }), sessionID: session.nativeSessionId };
  }

  async execution(session: TaskSession) {
    const { server, client, sessionID } = await this.connect(session);
    const messages = await client.getMessages(sessionID, { directory: server.directory, limit: messageLimit });
    return { ...executionFromMessages(messages), limited: messages.length >= messageLimit };
  }

  async turnEvidence(session: TaskSession, turnId: string) {
    const { server, client, sessionID } = await this.connect(session);
    const messages = await client.getMessages(sessionID, { directory: server.directory });
    const correlated = correlatedAssistants(messages, turnId);
    if (!correlated.promptFound) return { tools: [], limitation: "The admitted native prompt is not present in the authoritative session history." };
    return {
      tools: executionFromMessages(correlated.messages).tools,
      limitation: correlated.reason === "continuation_ambiguous" ? "Native compaction continuation was ambiguous; only tools with an authoritative parent chain are included." : null,
    };
  }

  async status(session: TaskSession) {
    const { server, client, sessionID } = await this.connect(session);
    const [native, statuses] = await Promise.all([client.getSession(sessionID, server.directory), client.getStatus(server.directory)]);
    return { status: statuses[sessionID]?.type ?? "idle" as const, updatedAt: native.time.updated };
  }

  async timeline(session: TaskSession) {
    const { server, client, sessionID } = await this.connect(session);
    const [messages, statuses] = await Promise.all([client.getMessages(sessionID, { directory: server.directory, limit: messageLimit }), client.getStatus(server.directory)]);
    const latest = [...messages].sort((a, b) => a.info.time.created - b.info.time.created).at(-1)?.info;
    const liveMessageId = statuses[sessionID]?.type === "busy" && latest?.role === "assistant" && latest.time.completed === undefined ? latest.id : null;
    return { usage: taskUsage(messages, session.kind), liveMessageId };
  }

  async archive(session: TaskSession) {
    const server = await readOpenCodeServer(taskSessionRuntimeDirectory(this.databasePath, session.id));
    if (!server && session.nativeSessionId) throw new Error("The task server identity is missing. Confirm that its commands have stopped before cleanup.");
    // ponytail: a bare pid check mistakes a reused pid for the server; compare identity like startup does
    if (server && await openCodeServerRunning(server)) {
      const statuses = await openCodeServerClient(server).getStatus(server.directory);
      if (Object.values(statuses).some(status => status.type !== "idle")) throw new Error("An agent is still active. Retry after it stops.");
    }
    return { display: server ? (argv: readonly string[]) => openCodeDisplayAttached(server, session.nativeSessionId, argv) : null, stop: async () => { if (server) await stopOpenCodeServer(server); } };
  }
}
