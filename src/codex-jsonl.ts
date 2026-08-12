import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { redact } from "./logging.js";
import { ExecutionReceiptSchema, type ExecutionReceipt } from "./developer-contracts.js";

const MAX_LINE_BYTES = 512 * 1024;
const MAX_SUMMARY = 4_000;

export class CodexJsonlParseError extends Error {
  readonly code: "oversized-output" | "malformed-line";

  constructor(code: CodexJsonlParseError["code"], message: string) {
    super(message);
    this.name = "CodexJsonlParseError";
    this.code = code;
  }
}

export interface CodexJsonlParseOptions {
  executionId: string;
  attempt: number;
  startSequence?: number;
  activeStep?: number | null;
  authorizedStepNumbers?: number[];
  worktreePath?: string;
  now?: () => Date;
  state?: CodexJsonlParserState;
}

export interface CodexJsonlParserState {
  sequence: number;
  activeStep: number | null;
  startedSteps: number[];
  terminalSteps: number[];
  expectedStepIndex: number;
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
  const text = typeof value === "string" ? value : JSON.stringify(redact(value)) ?? String(value);
  return text.slice(0, MAX_SUMMARY);
}

function itemValue(event: Record<string, unknown>): Record<string, unknown> {
  return (event.item && typeof event.item === "object" ? event.item : event) as Record<string, unknown>;
}

function itemId(event: Record<string, unknown>): string | null {
  return typeof event.item_id === "string" ? event.item_id : typeof event.itemId === "string" ? event.itemId : typeof itemValue(event).id === "string" ? String(itemValue(event).id) : null;
}

function marker(command: string): { kind: "step_started" | "step_completed" | "step_blocked"; stepNumber: number } | undefined {
  const match = /\bforge-step\s+(start|complete|block)\s+(\d+)\b/.exec(command.trim());
  if (!match) return undefined;
  return { kind: match[1] === "start" ? "step_started" : match[1] === "complete" ? "step_completed" : "step_blocked", stepNumber: Number(match[2]) };
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
  });
}

export function parseCodexJsonl(lines: Iterable<string>, options: CodexJsonlParseOptions): ParsedCodexJsonl {
  const receipts: ExecutionReceipt[] = [];
  const state = options.state ?? {
    sequence: options.startSequence ?? 0,
    activeStep: options.activeStep ?? null,
    startedSteps: [],
    terminalSteps: [],
    expectedStepIndex: 0,
    terminalItemIds: [],
  };
  const terminalItems = new Set(state.terminalItemIds);
  let sequence = state.sequence;
  let activeStep = state.activeStep;
  const authorizedSteps = new Set(options.authorizedStepNumbers ?? []);
  const startedSteps = new Set(state.startedSteps);
  const terminalSteps = new Set(state.terminalSteps);
  let expectedStepIndex = state.expectedStepIndex;
  let threadId: string | undefined = state.threadId;
  let finalReport: unknown;
  let malformedLines = 0;
  const push = (input: Parameters<typeof createReceipt>[2]) => {
    sequence += 1;
    receipts.push(createReceipt(options, sequence, input));
  };

  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new CodexJsonlParseError("oversized-output", "Codex JSONL output exceeded the bounded line limit");
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      event = parsed as Record<string, unknown>;
    } catch {
      malformedLines += 1;
      push({ kind: "reconciliation", stepNumber: activeStep, sourceItemId: null, summary: "Malformed Codex JSONL line preserved as evidence", exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `malformed:${createHash("sha256").update(line).digest("hex")}` });
      continue;
    }
    if (typeof event.thread_id === "string") threadId = event.thread_id;
    if (typeof event.threadId === "string") threadId = event.threadId;
    const type = typeof event.type === "string" ? event.type : "unknown";
    const item = itemValue(event);
    const sourceItemId = itemId(event);
    const itemType = typeof item.type === "string" ? item.type : "";
    const terminal = type === "item.completed" || type === "turn.completed" || type === "turn.failed";
    if (terminal && sourceItemId && terminalItems.has(sourceItemId)) continue;
    if (terminal && sourceItemId) terminalItems.add(sourceItemId);

    if (itemType === "command_execution" || type === "command_execution") {
      const command = typeof item.command === "string" ? item.command : typeof item.cmd === "string" ? item.cmd : "";
      const stepMarker = marker(command);
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : typeof item.exitCode === "number" ? item.exitCode : null;
      const successfulTerminalMarker = Boolean(stepMarker && terminal && (exitCode === null || exitCode === 0));
      const completedSummary = `${command}\n${summary(item.aggregated_output ?? item.output ?? item.status ?? "")}`;
      const pushTestResult = (stepNumber: number | null) => {
        if (isTestCommand(command)) push({ kind: "test_result", stepNumber, sourceItemId, summary: completedSummary, exitCode, artifactId: null, artifactSha256: null, idempotencyKey: `test-result:${sourceItemId ?? createHash("sha256").update(command).digest("hex")}` });
      };
      if (successfulTerminalMarker && stepMarker) {
        const validRange = authorizedSteps.size === 0 || authorizedSteps.has(stepMarker.stepNumber);
        const expectedStep = [...authorizedSteps][expectedStepIndex];
        const validTransition = stepMarker.kind === "step_started"
          ? validRange && activeStep === null && !startedSteps.has(stepMarker.stepNumber) && (expectedStep === undefined || expectedStep === stepMarker.stepNumber)
          : validRange && activeStep === stepMarker.stepNumber && !terminalSteps.has(stepMarker.stepNumber);
        if (!validTransition) {
          push({ kind: "reconciliation", stepNumber: activeStep, sourceItemId, summary: `Invalid forge-step marker: ${command}`.slice(0, MAX_SUMMARY), exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `invalid-marker:${sourceItemId ?? command}:${stepMarker.kind}` });
        } else if (stepMarker.kind === "step_started") {
          activeStep = stepMarker.stepNumber;
          startedSteps.add(stepMarker.stepNumber);
          expectedStepIndex += 1;
          push({ kind: stepMarker.kind, stepNumber: stepMarker.stepNumber, sourceItemId, summary: command, exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `marker:${sourceItemId ?? command}:${stepMarker.kind}` });
        } else {
          terminalSteps.add(stepMarker.stepNumber);
          activeStep = null;
          push({ kind: stepMarker.kind, stepNumber: stepMarker.stepNumber, sourceItemId, summary: command, exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `marker:${sourceItemId ?? command}:${stepMarker.kind}` });
        }
        if (type === "item.completed") {
          push({ kind: "command_finished", stepNumber: stepMarker.stepNumber, sourceItemId, summary: completedSummary, exitCode, artifactId: null, artifactSha256: null, idempotencyKey: `command-finished:${sourceItemId ?? createHash("sha256").update(command).digest("hex")}` });
          pushTestResult(stepMarker.stepNumber);
        }
      } else if (type === "item.started") {
        push({ kind: "command_started", stepNumber: stepMarker?.kind === "step_started" ? stepMarker.stepNumber : activeStep, sourceItemId, summary: command, exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `command-start:${sourceItemId ?? createHash("sha256").update(command).digest("hex")}` });
      } else if (type === "item.completed" || typeof item.exit_code === "number" || typeof item.exitCode === "number") {
        const stepNumber = stepMarker?.kind === "step_started" ? stepMarker.stepNumber : activeStep;
        push({ kind: "command_finished", stepNumber, sourceItemId, summary: completedSummary, exitCode, artifactId: null, artifactSha256: null, idempotencyKey: `command-finished:${sourceItemId ?? createHash("sha256").update(command).digest("hex")}` });
        pushTestResult(stepNumber);
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
          push({ kind: "reconciliation", stepNumber: activeStep, sourceItemId, summary: "Developer file-change path escaped the owned worktree", exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `file-escape:${sourceItemId ?? path}:${path}` });
          continue;
        }
        push({ kind: "file_change", stepNumber: activeStep, sourceItemId, summary: normalized, exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `file:${sourceItemId ?? normalized}:${normalized}` });
      }
      continue;
    }
    if (type === "item.completed" && itemType === "agent_message" && typeof item.text === "string") {
      try { finalReport = JSON.parse(item.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { /* The schema validator reports a missing/invalid report later. */ }
      continue;
    }
    if (type === "error" || itemType === "error") push({ kind: "reconciliation", stepNumber: activeStep, sourceItemId, summary: summary(event), exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `error:${sourceItemId ?? createHash("sha256").update(line).digest("hex")}` });
    else if (!(["thread.started", "turn.started", "turn.completed", "turn.failed", "item.started", "item.updated", "item.completed"].includes(type))) {
      push({ kind: "reconciliation", stepNumber: activeStep, sourceItemId, summary: `Unknown Codex event preserved: ${summary(event)}`, exitCode: null, artifactId: null, artifactSha256: null, idempotencyKey: `unknown:${sourceItemId ?? createHash("sha256").update(line).digest("hex")}` });
    }
  }
  return {
    receipts,
    ...(threadId ? { threadId } : {}),
    ...(finalReport !== undefined ? { finalReport } : {}),
    malformedLines,
    parserState: {
      sequence,
      activeStep,
      startedSteps: [...startedSteps].sort((a, b) => a - b),
      terminalSteps: [...terminalSteps].sort((a, b) => a - b),
      expectedStepIndex,
      terminalItemIds: [...terminalItems],
      ...(threadId ? { threadId } : {}),
    },
  };
}
