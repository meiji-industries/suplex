import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { redact } from "./logging.js";
import { json } from "./task-utils.js";
import { parseApplyPatch } from "./codex-patch.js";
const TimestampSchema = z.string().datetime();
const NonnegativeInteger = z.number().int().nonnegative();
export const CodexRolloutSessionMetaSchema = z
  .object({
    session_id: z.string().min(1),
    cwd: z.string().min(1),
    originator: z.string().min(1),
    cli_version: z.string().min(1),
  })
  .passthrough();
export const CodexRolloutTurnContextSchema = z
  .object({
    turn_id: z.string().min(1),
    cwd: z.string().min(1),
    model: z.string().min(1),
    effort: z.string().min(1),
  })
  .passthrough();
export const CodexRolloutEventPayloadSchema = z.union([
  z
    .object({
      type: z.literal("user_message"),
      message: z.string(),
      images: z.array(z.unknown()).optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("task_started"),
      turn_id: z.string().min(1),
      started_at: z.number().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("task_complete"),
      turn_id: z.string().min(1),
      duration_ms: NonnegativeInteger.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("token_count"),
      info: z
        .object({
          total_token_usage: z
            .object({
              input_tokens: NonnegativeInteger.optional(),
              cached_input_tokens: NonnegativeInteger.optional(),
              cache_write_input_tokens: NonnegativeInteger.optional(),
              output_tokens: NonnegativeInteger.optional(),
              reasoning_output_tokens: NonnegativeInteger.optional(),
              total_tokens: NonnegativeInteger.optional(),
            })
            .passthrough(),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("agent_message"),
      message: z.string(),
      phase: z.string().optional(),
    })
    .passthrough(),
  z.object({ type: z.string().min(1) }).passthrough(),
]);
export const CodexRolloutLineSchema = z
  .object({
    timestamp: TimestampSchema,
    ordinal: NonnegativeInteger.optional(),
    type: z.enum([
      "session_meta",
      "turn_context",
      "event_msg",
      "response_item",
      "world_state",
    ]),
    payload: z.unknown(),
  })
  .passthrough()
  .superRefine((line, context) => {
    if (
      line.type === "session_meta" &&
      !CodexRolloutSessionMetaSchema.safeParse(line.payload).success
    )
      context.addIssue({
        code: "custom",
        message: "invalid session_meta payload",
      });
    if (
      line.type === "turn_context" &&
      !CodexRolloutTurnContextSchema.safeParse(line.payload).success
    )
      context.addIssue({
        code: "custom",
        message: "invalid turn_context payload",
      });
    if (
      line.type === "event_msg" &&
      !CodexRolloutEventPayloadSchema.safeParse(line.payload).success
    )
      context.addIssue({
        code: "custom",
        message: "invalid event_msg payload",
      });
  });
export const NeutralTimelineEventSchema = z
  .object({
    kind: z.enum([
      "turn_started",
      "thinking_summary",
      "tool_call",
      "command",
      "file_change",
      "message",
      "usage",
      "turn_finished",
    ]),
    timestamp: TimestampSchema,
    sessionId: z.string().min(1),
    forgeTurnId: z.string().min(1),
    executionId: z.string().min(1),
    executionRole: z.enum(["planner", "reviewer", "builder", "integrator"]),
    sourceOffset: NonnegativeInteger,
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export const RoleResultFileEnvelopeSchema = z
  .object({
    version: z.literal(1),
    turnId: z.string().min(1),
    result: z.unknown(),
  })
  .strict();
export type CodexRolloutLine = z.infer<typeof CodexRolloutLineSchema>;
export type NeutralTimelineEvent = z.infer<typeof NeutralTimelineEventSchema>;
export type RoleResultFileEnvelope = z.infer<
  typeof RoleResultFileEnvelopeSchema
>;
export interface RolloutParserInput {
  sessionId: string;
  forgeTurnId: string;
  executionId: string;
  executionRole: NeutralTimelineEvent["executionRole"];
  offset: number;
}
export interface RolloutParseResult {
  events: NeutralTimelineEvent[];
  offset: number;
  remainder: string;
  unknown: number;
  taskComplete: boolean;
  turnId?: string;
}
const clip = (value: string, max = 4000): string =>
  value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").slice(0, max);
const safePreview = (value: string, max: number): string =>
  clip(String(redact(value)), max);
const commandFromInput = (value: unknown): string => {
  if (typeof value !== "string") return "Run tool";
  const match = value.match(/"cmd"\s*:\s*("(?:\\.|[^"\\])*")/);
  if (match) {
    const command = json(match[1]!, undefined);
    return typeof command === "string" ? safePreview(command, 600) || "Run command" : "Run command";
  }
  if (/\*\*\* Begin Patch\b/.test(value)) return "Apply patch";
  return "Run tool";
};
const outputFromPayload = (value: unknown): string =>
  Array.isArray(value)
    ? safePreview(value.flatMap((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string" ? [(item as Record<string, unknown>).text as string] : []).join("\n"), 600)
    : typeof value === "string" ? safePreview(value, 600) : "";
const event = (
  input: RolloutParserInput,
  offset: number,
  timestamp: string,
  kind: NeutralTimelineEvent["kind"],
  data: Record<string, unknown>,
): NeutralTimelineEvent =>
  NeutralTimelineEventSchema.parse({
    kind,
    timestamp,
    sessionId: input.sessionId,
    forgeTurnId: input.forgeTurnId,
    executionId: input.executionId,
    executionRole: input.executionRole,
    sourceOffset: offset,
    data,
  });
/** Parse only complete JSONL rows. Raw rollout data deliberately never escapes this module. */
export function parseRolloutChunk(
  input: RolloutParserInput,
  chunk: string,
  remainder = "",
): RolloutParseResult {
  const text = remainder + chunk;
  const rows = text.split("\n");
  const tail = rows.pop() ?? "";
  let offset = input.offset;
  let unknown = 0;
  let taskComplete = false;
  let turnId: string | undefined;
  const events: NeutralTimelineEvent[] = [];
  for (const row of rows) {
    const bytes = Buffer.byteLength(`${row}\n`);
    offset += bytes;
    let line: CodexRolloutLine;
    try {
      line = CodexRolloutLineSchema.parse(json(row, undefined));
    } catch {
      events.push(
        event(input, offset, new Date(0).toISOString(), "message", {
          role: "system",
          level: "error",
          text: "Malformed Codex rollout line",
        }),
      );
      continue;
    }
    const payload = line.payload as Record<string, unknown>;
    const type = typeof payload.type === "string" ? payload.type : "";
    const stamp = line.timestamp;
    if (line.type === "event_msg" && type === "task_started") {
      turnId =
        typeof payload.turn_id === "string" ? payload.turn_id : undefined;
      events.push(event(input, offset, stamp, "turn_started", { turnId }));
    } else if (line.type === "event_msg" && type === "task_complete") {
      turnId = typeof payload.turn_id === "string" ? payload.turn_id : turnId;
      taskComplete = true;
      events.push(
        event(input, offset, stamp, "turn_finished", {
          turnId,
          durationMs:
            typeof payload.duration_ms === "number"
              ? payload.duration_ms
              : undefined,
          ...(typeof payload.error === "string" && payload.error.length > 0
            ? { error: true }
            : {}),
        }),
      );
    } else if (
      line.type === "event_msg" &&
      (type === "user_message" || type === "agent_message")
    ) {
      const message =
        typeof payload.message === "string" ? clip(payload.message) : "";
      if (message)
        events.push(
          event(input, offset, stamp, "message", {
            role: type === "user_message" ? "human" : "agent",
            text: message,
            ...(typeof payload.phase === "string"
              ? { phase: payload.phase }
              : {}),
          }),
        );
    } else if (line.type === "event_msg" && type === "token_count") {
      const usage = (payload.info as Record<string, unknown> | undefined)
        ?.total_token_usage;
      if (usage && typeof usage === "object")
        events.push(
          event(
            input,
            offset,
            stamp,
            "usage",
            Object.fromEntries(
              Object.entries(usage as Record<string, unknown>).filter(
                ([, v]) => typeof v === "number" && v >= 0,
              ),
            ),
          ),
        );
    } else if (line.type === "response_item" && payload.type === "reasoning") {
      const summary = Array.isArray(payload.summary)
        ? payload.summary
            .filter((v): v is string => typeof v === "string")
            .join("\n")
        : typeof payload.summary === "string"
          ? payload.summary
          : "";
      if (summary)
        events.push(
          event(input, offset, stamp, "thinking_summary", {
            text: clip(summary),
          }),
        );
      else unknown += 1;
    } else if (
      line.type === "response_item" &&
      payload.type === "message" &&
      (payload.role === "assistant" ||
        payload.role === "output" ||
        payload.role === "user")
    ) {
      const content =
        typeof payload.text === "string"
          ? payload.text
          : typeof payload.content === "string"
            ? payload.content
            : Array.isArray(payload.content)
              ? payload.content
                  .flatMap((item) => {
                    if (!item || typeof item !== "object") return [];
                    const entry = item as Record<string, unknown>;
                    return (entry.type === "input_text" ||
                      entry.type === "text") &&
                      typeof entry.text === "string"
                      ? [entry.text]
                      : [];
                  })
                  .join("\n")
            : "";
      if (content)
        events.push(
          event(input, offset, stamp, "message", {
            role: payload.role === "user" ? "human" : "agent",
            text: clip(content),
          }),
        );
      else unknown += 1;
    } else if (
      line.type === "response_item" &&
      payload.type === "custom_tool_call"
    ) {
      const name = typeof payload.name === "string" ? payload.name : "tool";
      const patch =
        typeof payload.input === "string"
          ? parseApplyPatch(payload.input, safePreview)
          : undefined;
      events.push(
        event(
          input,
          offset,
          stamp,
          name === "exec_command" || name === "exec" ? "command" : "tool_call",
          {
            id:
              typeof payload.call_id === "string" ? payload.call_id : undefined,
            name,
            text: commandFromInput(payload.input),
            status:
              typeof payload.status === "string" ? payload.status : undefined,
            ...(patch ? { patch } : {}),
          },
        ),
      );
    } else if (
      line.type === "response_item" &&
      payload.type === "custom_tool_call_output"
    ) {
      const id = typeof payload.call_id === "string" ? payload.call_id : undefined;
      const output = outputFromPayload(payload.output);
      if (id && output)
        events.push(event(input, offset, stamp, "tool_call", { id, output }));
      else unknown += 1;
    } else if (
      line.type === "event_msg" &&
      (type === "item_completed" || type === "patch_apply_end")
    ) {
      const path =
        typeof payload.path === "string" &&
        !payload.path.startsWith("/") &&
        !payload.path.includes("..")
          ? payload.path
          : undefined;
      if (path)
        events.push(
          event(input, offset, stamp, "file_change", {
            path,
            status:
              typeof payload.status === "string" ? payload.status : undefined,
          }),
        );
      else unknown += 1;
    } else unknown += 1;
  }
  return {
    events,
    offset,
    remainder: tail,
    unknown,
    taskComplete,
    ...(turnId ? { turnId } : {}),
  };
}
export interface RolloutCandidate {
  path: string;
  sessionId: string;
  cwd: string;
}
export async function rolloutCandidatePaths(
  codexHome = process.env.CODEX_HOME ?? `${homedir()}/.codex`,
): Promise<string[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(path);
    }
  };
  await visit(`${codexHome}/sessions`);
  return paths;
}
export async function discoverRollout(
  candidates: readonly string[],
  expected: {
    sessionId?: string;
    cwd: string;
    before?: ReadonlySet<string>;
    marker?: string;
    preferNewestMarker?: boolean;
  },
): Promise<RolloutCandidate> {
  const expectedCwd = await realpath(expected.cwd);
  const found: Array<RolloutCandidate & { hasMarker: boolean; modifiedAt: number }> = [];
  for (const path of candidates) {
    let source: Buffer;
    try {
      source = await readFile(path);
    } catch {
      continue;
    }
    try {
      const first = source.toString("utf8").split("\n")[0] ?? "";
      const row = CodexRolloutLineSchema.parse(json(first, undefined));
      if (row.type !== "session_meta") continue;
      const meta = CodexRolloutSessionMetaSchema.parse(row.payload);
      if ((await realpath(meta.cwd)) !== expectedCwd) continue;
      found.push({
        path: resolve(path),
        sessionId: meta.session_id,
        cwd: expectedCwd,
        hasMarker: expected.marker ? source.includes(expected.marker) : false,
        modifiedAt: (await stat(path)).mtimeMs,
      });
    } catch {
      /* invalid candidates are never adopted */
    }
  }
  const eligible = expected.sessionId
    ? found.filter((item) => item.sessionId === expected.sessionId)
    : expected.marker
      ? found.filter((item) => item.hasMarker)
    : found.filter((item) => !expected.before?.has(item.path));
  if (
    expected.marker &&
    !expected.sessionId &&
    expected.preferNewestMarker !== false &&
    eligible.length > 0
  )
    return eligible.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]!;
  if (eligible.length === 0)
    throw new Error("Codex rollout identity is missing");
  if (eligible.length !== 1)
    throw new Error("Codex rollout identity is ambiguous");
  return eligible[0]!;
}
export function timelineEventId(
  sessionId: string,
  sourceOffset: number,
): string {
  return `timeline_${createHash("sha256").update(`${sessionId}\0${sourceOffset}`).digest("hex")}`;
}
