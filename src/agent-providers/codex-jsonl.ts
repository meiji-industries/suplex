import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { redact, StructuredLogger } from "../logging.js";
import { ExecutionReceiptSchema, type ExecutionReceipt } from "../developer-contracts.js";

const MAX_SUMMARY = 4_000;

export interface CodexJsonlParseOptions {
  executionId: string;
  attempt: number;
  startSequence?: number;
  worktreePath?: string;
  now?: () => Date;
  state?: CodexJsonlParserState;
}

export interface CodexJsonlParserState {
  sequence: number;
  terminalItemIds: string[];
  threadId?: string;
}

export interface ParsedCodexJsonl {
  receipts: ExecutionReceipt[];
  threadId?: string;
  finalReport?: unknown;
  malformedLines: number;
  parserState: CodexJsonlParserState;
}

function summary(value: unknown): string {
  const text = typeof value === "string" ? String(redact(value)) : JSON.stringify(redact(value)) ?? String(value);
  return text.slice(0, MAX_SUMMARY);
}

function namedTool(item: Record<string, unknown>): string {
  return [item.server_name, item.server, item.tool_name, item.tool, item.name]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(".");
}

function todoSummary(items: unknown): string {
  if (!Array.isArray(items)) return summary(items);
  return items.map((item) => {
    if (!item || typeof item !== "object") return summary(item);
    const value = item as Record<string, unknown>;
    const text = [value.text, value.title, value.description].find((part): part is string => typeof part === "string");
    return [text ?? summary(value), typeof value.status === "string" ? value.status : undefined].filter(Boolean).join(" — ");
  }).join("\n");
}

function itemValue(event: Record<string, unknown>): Record<string, unknown> {
  return (event.item && typeof event.item === "object" ? event.item : event) as Record<string, unknown>;
}

function itemId(event: Record<string, unknown>): string | null {
  return typeof event.item_id === "string" ? event.item_id : typeof event.itemId === "string" ? event.itemId : typeof itemValue(event).id === "string" ? String(itemValue(event).id) : null;
}

function isTestCommand(command: string): boolean {
  return /(?:^|[\s'";&|])(?:test\s+|(?:pnpm|npm|yarn|bun)\s+(?:exec\s+)?(?:test|vitest)\b|vitest\b|pytest\b|cargo\s+test\b|go\s+test\b|dotnet\s+test\b|mise\s+run\s+test\b)/i.test(command);
}

function safeRepositoryPath(raw: string, worktreePath: string | undefined): string | undefined {
  if (!worktreePath || raw.includes("\\") || (!isAbsolute(raw) && raw.split("/").some((part) => part === ".."))) return undefined;
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(worktreePath, raw);
  const relativePath = relative(resolve(worktreePath), candidate);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return undefined;
  return relativePath.split(sep).join("/");
}

function createReceipt(options: CodexJsonlParseOptions, sequence: number, input: Pick<ExecutionReceipt, "kind" | "stepNumber" | "sourceItemId" | "summary" | "exitCode" | "artifactId" | "artifactSha256" | "idempotencyKey">): ExecutionReceipt {
  return ExecutionReceiptSchema.parse({
    eventId: `receipt_${createHash("sha256").update(`${options.executionId}:${sequence}:${input.idempotencyKey}`).digest("hex").slice(0, 32)}`,
    executionId: options.executionId,
    attempt: options.attempt,
    sequence,
    occurredAt: (options.now ?? (() => new Date()))().toISOString(),
    ...input,
    // Receipts are browser-visible evidence. Keep the parser boundary safe even
    // when a future receipt type bypasses summary().
    summary: String(redact(input.summary)).slice(0, MAX_SUMMARY),
    stepNumber: null,
  });
}

export function parseCodexJsonl(lines: Iterable<string>, options: CodexJsonlParseOptions): ParsedCodexJsonl {
  const receipts: ExecutionReceipt[] = [];
  const state = options.state ?? {
    sequence: options.startSequence ?? 0,
    terminalItemIds: [],
  };
  const terminalItems = new Set(state.terminalItemIds);
  let sequence = state.sequence;
  let threadId: string | undefined = state.threadId;
  let finalReport: unknown;
  let malformedLines = 0;
  let observedAt: string | undefined;
  const logger = new StructuredLogger();
  const push = (input: Parameters<typeof createReceipt>[2]) => {
    sequence += 1;
    const receipt = createReceipt(options, sequence, input);
    if (observedAt) receipt.occurredAt = observedAt;
    receipts.push(receipt);
  };

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      event = parsed as Record<string, unknown>;
    } catch {
      malformedLines += 1;
      logger.warn("Skipping malformed Codex JSONL line", {}, { byteLength: Buffer.byteLength(line, "utf8") });
      continue;
    }
    if (typeof event.thread_id === "string") threadId = event.thread_id;
    if (typeof event.threadId === "string") threadId = event.threadId;
    observedAt = typeof event.observedAt === "string" && !Number.isNaN(Date.parse(event.observedAt)) ? event.observedAt : undefined;
    const type = typeof event.type === "string" ? event.type : "unknown";
    if (type.startsWith("forge.")) continue;
    const item = itemValue(event);
    const sourceItemId = itemId(event);
    const itemType = typeof item.type === "string" ? item.type : "";
    const terminal = type === "item.completed" || type === "turn.completed" || type === "turn.failed";
    if (terminal && sourceItemId && terminalItems.has(sourceItemId)) continue;
    if (terminal && sourceItemId) terminalItems.add(sourceItemId);

    if (itemType === "command_execution" || type === "command_execution") {
      const command = typeof item.command === "string" ? item.command : typeof item.cmd === "string" ? item.cmd : "";
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : typeof item.exitCode === "number" ? item.exitCode : null;
      const completedSummary = `${command}\n${summary(item.aggregated_output ?? item.output ?? item.status ?? "")}`;
      const pushTestResult = () => {
        if (isTestCommand(command)) push({ kind: "test_result", stepNumber: null, sourceItemId, summary: completedSummary, exitCode, artifactId: null, artifactSha256: null, idempotencyKey: `test-result:${sourceItemId ?? createHash("sha256").update(command).digest("hex")}` });
      };
      if (type === "item.started") {
        push({ kind: "command_started", stepNumber: null, sourceItemId, summary: command, exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `command-start:${sourceItemId ?? createHash("sha256").update(command).digest("hex")}` });
      } else if (type === "item.completed" || typeof item.exit_code === "number" || typeof item.exitCode === "number") {
        push({ kind: "command_finished", stepNumber: null, sourceItemId, summary: completedSummary, exitCode, artifactId: null, artifactSha256: null, idempotencyKey: `command-finished:${sourceItemId ?? createHash("sha256").update(command).digest("hex")}` });
        pushTestResult();
      }
      continue;
    }
    if (itemType === "file_change") {
      const paths = Array.isArray(item.changes)
        ? item.changes.map((change) => change && typeof change === "object" ? (change as Record<string, unknown>).path : undefined)
        : Array.isArray(item.paths) ? item.paths : [item.path ?? item.file_path ?? ""];
      for (const path of paths) if (typeof path === "string" && path) {
        const normalized = safeRepositoryPath(path, options.worktreePath);
        if (!normalized) {
          push({ kind: "reconciliation", stepNumber: null, sourceItemId, summary: "Developer file-change path escaped the owned worktree", exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `file-escape:${sourceItemId ?? path}:${path}` });
          continue;
        }
        push({ kind: "file_change", stepNumber: null, sourceItemId, summary: normalized, exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `file:${sourceItemId ?? normalized}:${normalized}` });
      }
      continue;
    }
    if (type === "item.completed" && itemType === "agent_message" && typeof item.text === "string") {
      push({ kind: "agent_update", stepNumber: null, sourceItemId, summary: item.text, exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `agent-update:${sourceItemId ?? createHash("sha256").update(item.text).digest("hex")}` });
      try { finalReport = JSON.parse(item.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { /* The schema validator reports a missing/invalid report later. */ }
      continue;
    }
    if (type === "item.completed" && itemType === "reasoning" && typeof item.text === "string") {
      push({ kind: "agent_update", stepNumber: null, sourceItemId, summary: `Reasoning summary: ${item.text}`, exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `reasoning:${sourceItemId ?? createHash("sha256").update(item.text).digest("hex")}` });
      continue;
    }
    if ((type === "item.started" || type === "item.completed") && (itemType.includes("mcp") || itemType.includes("tool"))) {
      const name = namedTool(item);
      const detail = type === "item.started" ? item.arguments : item.error ?? item.result;
      const verb = type === "item.started" ? "Using" : item.error ? "Tool failed" : "Used";
      push({ kind: "tool_call", stepNumber: null, sourceItemId, summary: `${verb} ${name || "a tool"}${detail === undefined || detail === null ? "" : `\n${summary(detail)}`}`, exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `tool-call:${type}:${sourceItemId ?? createHash("sha256").update(line).digest("hex")}` });
      continue;
    }
    if ((type === "item.started" || type === "item.completed") && itemType === "web_search") {
      push({ kind: "tool_call", stepNumber: null, sourceItemId, summary: `${type === "item.started" ? "Searching" : "Searched"}: ${summary(item.query ?? item.action ?? "the web")}`, exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `web-search:${type}:${sourceItemId ?? createHash("sha256").update(line).digest("hex")}` });
      continue;
    }
    if ((type === "item.updated" || type === "item.completed") && itemType === "todo_list") {
      const detail = todoSummary(item.items);
      push({ kind: "agent_update", stepNumber: null, sourceItemId, summary: `Plan update:${detail ? `\n${detail}` : " updated"}`, exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `plan-update:${sourceItemId ?? "unknown"}:${createHash("sha256").update(detail).digest("hex")}` });
      continue;
    }
    if (type === "turn.failed") {
      const error = event.error && typeof event.error === "object" ? event.error as Record<string, unknown> : event;
      push({ kind: "reconciliation", stepNumber: null, sourceItemId, summary: `Codex turn failed: ${summary(error.message ?? "Unknown error")}`, exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `turn-failed:${createHash("sha256").update(line).digest("hex")}` });
    }
    else if (type === "error" || itemType === "error") {
      const message = summary(item.message ?? event.message ?? "");
      if (message && !/^Reconnecting\.\.\./.test(message)) push({ kind: "reconciliation", stepNumber: null, sourceItemId, summary: `Codex reported an error: ${message}`, exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `error:${sourceItemId ?? createHash("sha256").update(line).digest("hex")}` });
    }
    else if (!(["thread.started", "turn.started", "turn.completed", "turn.failed", "item.started", "item.updated", "item.completed"].includes(type))) {
      push({ kind: "reconciliation", stepNumber: null, sourceItemId, summary: "Codex event could not be classified", exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `unknown:${sourceItemId ?? createHash("sha256").update(line).digest("hex")}` });
    }
  }
  return {
    receipts,
    ...(threadId ? { threadId } : {}),
    ...(finalReport !== undefined ? { finalReport } : {}),
    malformedLines,
    parserState: {
      sequence,
      terminalItemIds: [...terminalItems],
      ...(threadId ? { threadId } : {}),
    },
  };
}
