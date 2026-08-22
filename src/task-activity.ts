import { redact } from "./logging.js";
import { jsonRequired } from "./task-utils.js";

export type TaskActivityKind = "thinking" | "command" | "output" | "message" | "status";
export interface TaskActivityEvent { at: string; kind: TaskActivityKind; text: string; exitCode?: number }

const OUTPUT_LIMIT = 2 * 1024;

function text(value: unknown, limit = 16 * 1024): string {
  const redacted = typeof value === "string" ? redact(value) : redact(JSON.stringify(value) ?? "");
  return String(redacted).slice(-limit).trim();
}

function timestamp(value: unknown, fallback: string): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

/** Converts the public, persisted Codex JSONL stream into browser-safe activity rows. */
export function normalizeTaskActivityJsonl(lines: Iterable<string>, fallbackAt = new Date().toISOString()): TaskActivityEvent[] {
  const events: TaskActivityEvent[] = [];
  for (const raw of lines) {
    let envelope: Record<string, unknown>;
    try { envelope = jsonRequired(raw) as Record<string, unknown>; } catch { continue; }
    const at = timestamp(envelope.at ?? envelope.observedAt, fallbackAt);
    let event = envelope;
    if (typeof envelope.line === "string") {
      try { event = jsonRequired(envelope.line) as Record<string, unknown>; } catch { continue; }
    }
    const item = event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : event;
    const type = typeof event.type === "string" ? event.type : "";
    const itemType = typeof item.type === "string" ? item.type : "";
    const eventAt = timestamp(event.observedAt, at);
    if (itemType === "reasoning" && typeof item.text === "string") events.push({ at: eventAt, kind: "thinking", text: text(item.text) });
    else if (itemType === "command_execution") {
      const command = typeof item.command === "string" ? item.command : typeof item.cmd === "string" ? item.cmd : "";
      if (type === "item.started" && command) events.push({ at: eventAt, kind: "command", text: text(command) });
      if (type === "item.completed" || typeof item.exit_code === "number" || typeof item.exitCode === "number") {
        const output = text(item.aggregated_output ?? item.output ?? "", OUTPUT_LIMIT);
        events.push({ at: eventAt, kind: "output", text: output || command || "Command completed", ...(typeof (item.exit_code ?? item.exitCode) === "number" ? { exitCode: Number(item.exit_code ?? item.exitCode) } : {}) });
      }
    } else if (itemType === "agent_message" && typeof item.text === "string") events.push({ at: eventAt, kind: "message", text: text(item.text) });
  }
  return events.filter((event) => event.text.length > 0);
}
