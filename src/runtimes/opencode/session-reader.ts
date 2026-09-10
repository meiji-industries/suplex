import { readOpenCodeHistory } from "./session-history.js";
import { z } from "zod";
import { OpenCodeClient } from "./client.js";
import { OpenCodeTextPartSchema, OpenCodeToolPartSchema, type OpenCodeMessageEnvelope } from "./contracts.js";
import { openCodeServerClient, openCodeServerRunning, readOpenCodeServer, stopOpenCodeServer, type OpenCodeServerReference } from "./server.js";
import type { TaskSession } from "../../tasks/control.js";
import { TaskPlanItemSchema, type TaskExecution } from "../../tasks/execution/contracts.js";
import { taskSessionRuntimeDirectory, type NativeSessionReader } from "../task-harness.js";
import { taskUsage } from "../../tasks/usage.js";
import { correlatedAssistants } from "./session.js";
import type { ModelPricingCatalog } from "../../profiles/model-pricing.js";
import type { NativeHistoryMessage } from "../../tasks/history/contracts.js";

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

export function historyFromOpenCodeMessages(messages: readonly OpenCodeMessageEnvelope[]): NativeHistoryMessage[] {
  return messages.map((message, position) => ({ message, position })).sort((left, right) => left.message.info.time.created - right.message.info.time.created || left.position - right.position).flatMap(({ message }) => {
    const content: NativeHistoryMessage["content"] = [];
    for (const [originalBlockIndex, part] of message.parts.entries()) {
      const text = OpenCodeTextPartSchema.safeParse(part);
      if (text.success) {
        if (text.data.ignored) continue;
        content.push({ id: text.data.id ?? `${message.info.id}:text:${originalBlockIndex}`, type: "text", text: text.data.text });
        continue;
      }
      const parsed = OpenCodeToolPartSchema.safeParse(part);
      if (!parsed.success) continue;
      const tool = parsed.data;
      const details = ToolDetailsSchema.parse(tool.state);
      content.push({
        id: tool.id ?? `${message.info.id}:${tool.callID}`,
        type: "tool",
        name: tool.tool,
        status: tool.state.status,
        input: details.input,
        output: details.output ?? null,
        error: details.error ?? null,
      });
    }
    return content.length ? [{ id: message.info.id, role: message.info.role, createdAt: message.info.time.created, content }] : [];
  });
}

export class OpenCodeSessionReader implements NativeSessionReader {
  constructor(private readonly databasePath: string) {}

  private async connect(session: TaskSession): Promise<{ server: OpenCodeServerReference; client: OpenCodeClient; sessionID: string }> {
    const server = await readOpenCodeServer(taskSessionRuntimeDirectory(this.databasePath, session.id));
    if (!server || !session.nativeSessionId) throw new Error("Session is not available");
    return { server, client: new OpenCodeClient({ baseUrl: server.baseUrl, password: server.password, timeoutMs: 2000 }), sessionID: session.nativeSessionId };
  }

  async history(session: TaskSession) {
    if (!session.nativeSessionId) return [];
    let messages: OpenCodeMessageEnvelope[];
    if (session.current) {
      try { messages = await this.liveMessages(session); }
      catch { messages = await readOpenCodeHistory(session.nativeSessionId); }
    } else messages = await readOpenCodeHistory(session.nativeSessionId);
    return historyFromOpenCodeMessages(messages);
  }

  async execution(session: TaskSession) {
    if (!session.current && session.nativeSessionId) { const messages = await readOpenCodeHistory(session.nativeSessionId); return { ...executionFromMessages(messages.slice(-messageLimit)), limited: messages.length >= messageLimit }; }
    const { server, client, sessionID } = await this.connect(session);
    const messages = await client.getMessages(sessionID, { directory: server.directory, limit: messageLimit });
    return { ...executionFromMessages(messages), limited: messages.length >= messageLimit };
  }

  async turnEvidence(session: TaskSession, turnId: string) {
    const messages = !session.current && session.nativeSessionId ? await readOpenCodeHistory(session.nativeSessionId) : await this.liveMessages(session);
    const correlated = correlatedAssistants(messages, turnId);
    if (!correlated.promptFound) return { tools: [], limitation: "The admitted native prompt is not present in the authoritative session history." };
    return {
      tools: executionFromMessages(correlated.messages).tools,
      limitation: correlated.reason === "continuation_ambiguous" ? "Native compaction continuation was ambiguous; only tools with an authoritative parent chain are included." : null,
    };
  }

  private async liveMessages(session: TaskSession) {
    const { server, client, sessionID } = await this.connect(session);
    return client.getMessages(sessionID, { directory: server.directory });
  }

  async status(session: TaskSession) {
    const { server, client, sessionID } = await this.connect(session);
    const [native, statuses] = await Promise.all([client.getSession(sessionID, server.directory), client.getStatus(server.directory)]);
    return { status: statuses[sessionID]?.type ?? "idle" as const, updatedAt: native.time.updated };
  }

  async timeline(session: TaskSession, pricing?: ModelPricingCatalog) {
    if (!session.current && session.nativeSessionId) return { usage: taskUsage(await readOpenCodeHistory(session.nativeSessionId), session.kind, pricing), liveMessageId: null };
    const { server, client, sessionID } = await this.connect(session);
    const [messages, statuses] = await Promise.all([client.getMessages(sessionID, { directory: server.directory }), client.getStatus(server.directory)]);
    const latest = [...messages].sort((a, b) => a.info.time.created - b.info.time.created).at(-1)?.info;
    const liveMessageId = statuses[sessionID]?.type === "busy" && latest?.role === "assistant" && latest.time.completed === undefined ? latest.id : null;
    return { usage: taskUsage(messages, session.kind, pricing), liveMessageId };
  }

  async archive(session: TaskSession) {
    const server = await readOpenCodeServer(taskSessionRuntimeDirectory(this.databasePath, session.id));
    // ponytail: a bare pid check mistakes a reused pid for the server; compare identity like startup does
    if (server && await openCodeServerRunning(server)) {
      const statuses = await openCodeServerClient(server).getStatus(server.directory);
      if (Object.values(statuses).some(status => status.type !== "idle")) throw new Error("An agent is still active. Retry after it stops.");
    }
    return { stop: async () => { if (server) await stopOpenCodeServer(server); } };
  }
}
