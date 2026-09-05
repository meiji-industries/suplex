import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  OpenCodeMessageEnvelopeSchema,
  OpenCodeSessionSchema,
  OpenCodeSessionStatusSchema,
  OpenCodeSessionStatusMapSchema,
  type OpenCodeAssistantMessage,
  type OpenCodeMessageEnvelope,
  type OpenCodePromptState,
  type OpenCodeSessionStatus,
} from "./opencode-contracts.js";

export interface OpenCodePromptIntent {
  sessionID: string;
  messageID: string;
  directory: string;
  prompt: string;
  promptHash: string;
  model: { providerID: string; modelID: string };
  agent: string;
  variant: string;
  dispatch: OpenCodePromptDispatch;
}

export type OpenCodePromptDispatch = "not_submitted" | "ambiguous" | "rejected";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastMessageTimestamp = 0;
let messageCounter = 0;

export function createOpenCodeMessageID(timestamp = Date.now()): string {
  if (timestamp !== lastMessageTimestamp) {
    lastMessageTimestamp = timestamp;
    messageCounter = 0;
  }
  messageCounter += 1;
  const value = BigInt(timestamp) * BigInt(0x1000) + BigInt(messageCounter);
  const timeBytes = Buffer.alloc(6);
  for (let index = 0; index < timeBytes.length; index += 1)
    timeBytes[index] = Number((value >> BigInt(40 - 8 * index)) & BigInt(0xff));
  const random = randomBytes(14);
  const suffix = Array.from(random, (byte) => BASE62[byte % BASE62.length]).join("");
  return `msg_${timeBytes.toString("hex")}${suffix}`;
}

export function createOpenCodePromptIntent(input: Omit<OpenCodePromptIntent, "messageID" | "promptHash" | "dispatch"> & { messageID?: string; dispatch?: OpenCodePromptDispatch }): OpenCodePromptIntent {
  return {
    ...input,
    messageID: input.messageID ?? createOpenCodeMessageID(),
    promptHash: createHash("sha256").update(input.prompt, "utf8").digest("hex"),
    dispatch: input.dispatch ?? "not_submitted",
  };
}

export interface OpenCodePromptReadPort {
  getSession(sessionID: string, directory?: string): Promise<unknown>;
  getMessages(sessionID: string, query?: { directory?: string }): Promise<unknown[]>;
  getStatus(directory?: string): Promise<Record<string, unknown>>;
  promptAsync(input: { sessionID: string; messageID: string; text: string; model: { providerID: string; modelID: string }; agent: string; variant: string; directory?: string }): Promise<void>;
}

export type OpenCodePromptClaim = (intent: OpenCodePromptIntent) => Promise<boolean>;

export interface OpenCodeNativeEvidence {
  messageID: string;
  parentID: string;
  providerID: string;
  modelID: string;
  variant?: string;
  mode: string;
  agent: string;
  cwd: string;
  root: string;
  finish?: string;
}

export interface OpenCodePromptObservation {
  state: OpenCodePromptState;
  admission: "observed" | "not_observed" | "unknown";
  retry: "allowed" | "forbidden";
  sessionID: string;
  messageID: string;
  assistantMessageIDs: string[];
  assistantMessageID?: string;
  status?: OpenCodeSessionStatus;
  native?: OpenCodeNativeEvidence;
  reason?: string;
}

type UserEnvelope = OpenCodeMessageEnvelope & {
  info: Extract<OpenCodeMessageEnvelope["info"], { role: "user" }>;
};
type AssistantEnvelope = OpenCodeMessageEnvelope & {
  info: Extract<OpenCodeMessageEnvelope["info"], { role: "assistant" }>;
};

function isAssistantEnvelope(message: OpenCodeMessageEnvelope): message is AssistantEnvelope {
  return message.info.role === "assistant";
}

class OpenCodeReplayFailure extends Error {
  readonly code = "replay_blocked";

  constructor(message: string) {
    super(message);
    this.name = "OpenCodeReplayFailure";
  }
}

function messageText(message: OpenCodeMessageEnvelope): string {
  return message.parts
    .filter((part): part is Extract<OpenCodeMessageEnvelope["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function hasActiveTool(messages: readonly OpenCodeMessageEnvelope[]): boolean {
  return messages.some((message) => message.parts.some((part) => {
    if (part.type !== "tool" || !part.state || typeof part.state !== "object") return false;
    const status = (part.state as { status?: unknown }).status;
    return status === "pending" || status === "running";
  }));
}

function property(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, name);
}

function isAutoCompactionUser(message: OpenCodeMessageEnvelope): message is UserEnvelope {
  return message.info.role === "user" && message.parts.some((part) => part.type === "compaction" && property(part, "auto") === true);
}

function isSyntheticContinuationUser(message: OpenCodeMessageEnvelope): message is UserEnvelope {
  return message.info.role === "user" && (property(message.info, "synthetic") === true || message.parts.some((part) => part.type === "text" && property(part, "synthetic") === true));
}

function isCompactionSummary(message: OpenCodeMessageEnvelope): boolean {
  return message.info.role === "assistant" && message.info.agent === "compaction" && property(message.info, "summary") === true;
}

function assistantEvidence(message: OpenCodeAssistantMessage): OpenCodeNativeEvidence {
  return {
    messageID: message.id,
    parentID: message.parentID,
    providerID: message.providerID,
    modelID: message.modelID,
    ...(message.variant === undefined ? {} : { variant: message.variant }),
    mode: message.mode,
    agent: message.agent,
    cwd: message.path.cwd,
    root: message.path.root,
    ...(message.finish === undefined ? {} : { finish: message.finish }),
  };
}

function latest(messages: readonly OpenCodeMessageEnvelope[]): OpenCodeMessageEnvelope | undefined {
  return ordered(messages).at(-1);
}

function ordered(messages: readonly OpenCodeMessageEnvelope[]): OpenCodeMessageEnvelope[] {
  return [...messages].sort((left, right) => {
    const leftCreated = left.info.time.created;
    const rightCreated = right.info.time.created;
    return leftCreated - rightCreated || left.info.id.localeCompare(right.info.id);
  });
}

function correlatedAssistants(messages: readonly OpenCodeMessageEnvelope[], messageID: string): { messages: AssistantEnvelope[]; reason?: "continuation_ambiguous" | "later_user_boundary" } {
  const history = ordered(messages);
  const targetIndex = history.findIndex((message) => message.info.id === messageID);
  if (targetIndex < 0) return { messages: [] };

  const parentIDs = new Set([messageID]);
  const assistants: AssistantEnvelope[] = [];
  let pendingCompactionID: string | undefined;
  let awaitingSynthetic = false;
  let reason: "continuation_ambiguous" | "later_user_boundary" | undefined;

  for (const message of history.slice(targetIndex + 1)) {
    if (isAssistantEnvelope(message)) {
      if (pendingCompactionID !== undefined && message.info.parentID === pendingCompactionID && isCompactionSummary(message)) {
        pendingCompactionID = undefined;
        awaitingSynthetic = true;
        continue;
      }
      if (isCompactionSummary(message)) continue;
      if (parentIDs.has(message.info.parentID)) assistants.push(message);
      continue;
    }

    if (isAutoCompactionUser(message) && pendingCompactionID === undefined && !awaitingSynthetic) {
      pendingCompactionID = message.info.id;
      continue;
    }
    if (awaitingSynthetic && isSyntheticContinuationUser(message)) {
      parentIDs.add(message.info.id);
      awaitingSynthetic = false;
      continue;
    }
    reason = awaitingSynthetic || pendingCompactionID === undefined ? "later_user_boundary" : "continuation_ambiguous";
    break;
  }

  if (reason === undefined && (pendingCompactionID !== undefined || awaitingSynthetic)) reason = "continuation_ambiguous";
  return { messages: assistants, ...(reason === undefined ? {} : { reason }) };
}

function isFinalAssistant(message: OpenCodeMessageEnvelope): message is AssistantEnvelope {
  return message.info.role === "assistant" && message.info.time.completed !== undefined && message.info.finish === "stop";
}

function errorName(message: OpenCodeMessageEnvelope): string | undefined {
  return message.info.role === "assistant" ? message.info.error?.name : undefined;
}

function baseObservation(intent: OpenCodePromptIntent, input: Pick<OpenCodePromptObservation, "state" | "admission" | "retry"> & Partial<Pick<OpenCodePromptObservation, "reason" | "status">>): OpenCodePromptObservation {
  return { sessionID: intent.sessionID, messageID: intent.messageID, assistantMessageIDs: [], ...input };
}

function classify(
  intent: OpenCodePromptIntent,
  messages: OpenCodeMessageEnvelope[],
  status: OpenCodeSessionStatus | undefined,
  statusKnown: boolean,
): OpenCodePromptObservation {
  const userMessages = messages.filter((message): message is UserEnvelope => message.info.role === "user" && message.info.id === intent.messageID);
  if (userMessages.length === 0) {
    const replayable = intent.dispatch === "not_submitted" || intent.dispatch === "rejected";
    const blockedByBusySession = status?.type === "busy" || status?.type === "retry";
    return baseObservation(intent, {
      state: "unknown",
      admission: "not_observed",
      retry: replayable && statusKnown && !blockedByBusySession ? "allowed" : "forbidden",
      ...(status === undefined ? {} : { status }),
      reason: !replayable ? "admission_ambiguous" : !statusKnown ? "native_status_unavailable" : blockedByBusySession ? "native_session_busy" : "message_not_observed",
    });
  }
  const user = userMessages[0]!;
  if (user.info.sessionID !== intent.sessionID || messageText(user) !== intent.prompt) {
    return baseObservation(intent, { state: "unknown", admission: "unknown", retry: "forbidden", reason: "message_id_conflict", ...(status === undefined ? {} : { status }) });
  }
  const correlation = correlatedAssistants(messages, intent.messageID);
  const assistantMessages = correlation.messages.filter((message) => message.info.sessionID === intent.sessionID);
  const assistantMessageIDs = assistantMessages.map((message) => message.info.id);
  const last = latest(assistantMessages);
  const activeTool = hasActiveTool(assistantMessages);
  const common = { admission: "observed" as const, retry: "forbidden" as const, assistantMessageIDs, ...(status === undefined ? {} : { status }) };
  if (last?.info.role === "assistant") {
    const name = errorName(last);
    if (name === "MessageAbortedError") return { ...baseObservation(intent, { state: "interrupted", ...common, reason: "native_abort" }), assistantMessageID: last.info.id, native: assistantEvidence(last.info) };
    if (name) return { ...baseObservation(intent, { state: "error", ...common, reason: "native_error" }), assistantMessageID: last.info.id, native: assistantEvidence(last.info) };
    if (isFinalAssistant(last)) return { ...baseObservation(intent, { state: "completed", ...common }), assistantMessageID: last.info.id, native: assistantEvidence(last.info) };
    if (last.info.time.completed !== undefined && last.info.finish !== "tool-calls") return { ...baseObservation(intent, { state: "terminal_incomplete", ...common, reason: "native_terminal_incomplete" }), assistantMessageID: last.info.id, native: assistantEvidence(last.info) };
  }
  if (correlation.reason) return baseObservation(intent, { state: "unknown", ...common, reason: correlation.reason });
  if (activeTool) {
    return { ...baseObservation(intent, { state: "running", ...common, reason: "tool_pending_or_running" }), ...(last?.info.role === "assistant" ? { assistantMessageID: last.info.id, native: assistantEvidence(last.info) } : {}) };
  }
  const running = status?.type === "busy" || status?.type === "retry";
  return {
    ...baseObservation(intent, { state: running ? "running" : "admitted", ...common, reason: "final_response_not_observed" }),
    ...(last?.info.role === "assistant" ? { assistantMessageID: last.info.id, native: assistantEvidence(last.info) } : {}),
  };
}

function canonicalDirectoryFallback(value: string): string {
  const absolute = resolve(value);
  // macOS exposes /tmp through /private/tmp. This alias is deliberate and only
  // applies after realpath cannot resolve a disposable or not-yet-created path.
  if (process.platform === "darwin" && (absolute === "/private/tmp" || absolute.startsWith("/private/tmp/"))) return absolute.slice("/private".length);
  return absolute;
}

export async function canonicalOpenCodeDirectory(value: string): Promise<string> {
  try {
    return canonicalDirectoryFallback(await realpath(value));
  } catch {
    return canonicalDirectoryFallback(value);
  }
}

export async function reconcileOpenCodePrompt(client: OpenCodePromptReadPort, intent: OpenCodePromptIntent): Promise<OpenCodePromptObservation> {
  try {
    const parsedSession = OpenCodeSessionSchema.parse(await client.getSession(intent.sessionID, intent.directory));
    if (parsedSession.id !== intent.sessionID) return baseObservation(intent, { state: "unknown", admission: "unknown", retry: "forbidden", reason: "session_identity_conflict" });
    const [sessionDirectory, expectedDirectory] = await Promise.all([canonicalOpenCodeDirectory(parsedSession.directory), canonicalOpenCodeDirectory(intent.directory)]);
    if (sessionDirectory !== expectedDirectory) return baseObservation(intent, { state: "unknown", admission: "unknown", retry: "forbidden", reason: "session_directory_mismatch" });
    const messages = await client.getMessages(intent.sessionID, { directory: intent.directory });
    const parsedMessages = messages.map((message) => OpenCodeMessageEnvelopeSchema.parse(message));
    let parsedStatus: OpenCodeSessionStatus | undefined;
    let statusKnown = false;
    try {
      const statuses = OpenCodeSessionStatusMapSchema.parse(await client.getStatus(intent.directory));
      if (statuses[intent.sessionID] !== undefined) {
        parsedStatus = OpenCodeSessionStatusSchema.parse(statuses[intent.sessionID]);
      }
      statusKnown = true;
    } catch {
      // Status only supplies liveness. Message evidence remains authoritative.
    }
    return classify(intent, parsedMessages, parsedStatus, statusKnown);
  } catch {
    return baseObservation(intent, { state: "unknown", admission: "unknown", retry: "forbidden", reason: "native_read_unavailable" });
  }
}

export async function replayOpenCodePrompt(client: OpenCodePromptReadPort, intent: OpenCodePromptIntent, claim: OpenCodePromptClaim): Promise<{ messageID: string }> {
  const observed = await reconcileOpenCodePrompt(client, intent);
  if (observed.retry !== "allowed") throw new OpenCodeReplayFailure("OpenCode prompt was not proven absent; replay is blocked");
  if (!(await claim(intent))) throw new OpenCodeReplayFailure("OpenCode prompt replay claim was not acquired");
  await client.promptAsync({
    sessionID: intent.sessionID,
    messageID: intent.messageID,
    text: intent.prompt,
    model: intent.model,
    agent: intent.agent,
    variant: intent.variant,
    directory: intent.directory,
  });
  return { messageID: intent.messageID };
}

export { OpenCodeReplayFailure };
