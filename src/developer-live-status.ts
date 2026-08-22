import { redact } from "./logging.js";
import { jsonRequired } from "./task-utils.js";

const MAX_COMMAND_LENGTH = 80;

type CodexEvent = { type?: unknown; item?: { type?: unknown; command?: unknown; cmd?: unknown } };

/** Maps the public portion of a Codex JSONL event to a concise live status. */
export function developerLiveStatus(line: string): string | undefined {
  let event: CodexEvent;
  try { event = jsonRequired(line) as CodexEvent; } catch { return undefined; }
  const type = typeof event.type === "string" ? event.type : "";
  const itemType = typeof event.item?.type === "string" ? event.item.type : "";
  if (type === "item.started" && itemType === "command_execution") {
    const command = event.item?.command ?? event.item?.cmd;
    if (typeof command !== "string" || !command.trim()) return "Running a command";
    return `Running: ${String(redact(command)).replace(/\s+/g, " ").trim().slice(0, MAX_COMMAND_LENGTH)}`;
  }
  if (type === "item.started" && itemType === "reasoning") return "Thinking";
  if ((type === "item.completed" && itemType === "agent_message") || type === "turn.completed") return "Developer finished; awaiting verification";
  return undefined;
}

/** Coalesces high-frequency JSONL events into at most one row update every two seconds. */
export function createDeveloperLiveStatusReporter(update: (status: string | null) => void, now: () => number = Date.now): { report(line: string): void; set(status: string | null): void } {
  let lastWriteAt = -Infinity;
  return {
    report(line) {
      const status = developerLiveStatus(line);
      if (!status || now() - lastWriteAt < 2_000) return;
      update(status);
      lastWriteAt = now();
    },
    set(status) {
      update(status);
      lastWriteAt = now();
    },
  };
}
