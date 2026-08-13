import { redact } from "../logging.js";
import { defaultProcessController, processIdentityMatches, type OwnedProcess, type ProcessController, type ProcessInspection } from "../process-manager.js";

const MAX_EVENT_TEXT = 32_000;
const MAX_LINE = 128_000;
const sessionKey = /^(?:thread_id|threadId|session_id|sessionId)$/i;
const unsafeKey = /authorization|cookie|credential|password|private.?key|secret|token|api.?key|environment|env|reasoning/i;
const unsafePath = /(?:^|\/)(?:Users|home|tmp|var\/folders|keychain|runtime|agent-turns)(?:\/|$)/i;

function safeText(value: string): string {
  return String(redact(value)).replace(/(?:Bearer\s+[^\s,;]+|(?:gho_|github_pat_|sk-)[A-Za-z0-9_-]+)/gi, "[REDACTED]").replace(/(?:\/Users\/|\/home\/|\/tmp\/|[A-Za-z]:\\)[^\s"']+/g, "[PATH]").slice(0, MAX_EVENT_TEXT);
}

function sanitizeValue(value: unknown, key = ""): unknown {
  if (sessionKey.test(key) || unsafeKey.test(key)) return undefined;
  if (typeof value === "string") return unsafePath.test(value) ? "[PATH]" : safeText(value);
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => sanitizeValue(entry)).filter((entry) => entry !== undefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).flatMap(([entryKey, entryValue]) => {
      const sanitized = sanitizeValue(entryValue, entryKey);
      return sanitized === undefined ? [] : [[entryKey, sanitized]];
    }));
  }
  return typeof value === "number" || typeof value === "boolean" || value === null ? value : undefined;
}

export function sanitizeCodexEvent(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return { type: "text", text: safeText(String(value)) };
  const event = value as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "unknown";
  if (type.includes("reasoning")) return { type: "reasoning", redacted: true };
  const safe: Record<string, unknown> = { type };
  if (type === "item.completed" || type === "item.started") {
    const item = event.item;
    if (item && typeof item === "object") {
      const itemRecord = item as Record<string, unknown>;
      const itemType = typeof itemRecord.type === "string" ? itemRecord.type : "unknown";
      safe.item = itemType === "agent_message"
        ? { type: itemType, text: typeof itemRecord.text === "string" ? safeText(itemRecord.text) : "" }
        : itemType === "command_execution"
          ? { type: itemType, status: typeof itemRecord.status === "string" ? itemRecord.status : "unknown" }
          : { type: itemType };
    }
  } else if (type === "turn.completed") {
    if (event.usage && typeof event.usage === "object") safe.usage = sanitizeValue(event.usage, "usage");
  } else if (type === "error") {
    safe.error = { message: typeof event.message === "string" ? safeText(event.message) : "Codex returned an error" };
  } else if (type === "forge.wrapper_started") {
    const childPid = typeof event.childPid === "number" ? event.childPid : undefined;
    const childProcessGroup = typeof event.childProcessGroup === "number" ? event.childProcessGroup : undefined;
    const childStartIdentity = typeof event.childStartIdentity === "string" ? event.childStartIdentity : undefined;
    if (childPid && childProcessGroup && childStartIdentity) safe.child = { pid: childPid, processGroup: childProcessGroup, startIdentity: childStartIdentity };
  }
  return safe;
}

export function sanitizeCodexLine(line: string): string {
  try {
    return JSON.stringify(sanitizeCodexEvent(JSON.parse(line))).slice(0, MAX_LINE);
  } catch {
    return JSON.stringify({ type: "text", text: safeText(line) }).slice(0, MAX_LINE);
  }
}

export const SAFE_CODEX_FAILURE_SUMMARIES: Record<string, string> = {
  version_incompatible: "The installed Codex version does not support the Forge Lead contract.",
  unauthenticated: "Codex local authentication is unavailable. Sign in again, then retry.",
  capacity_unavailable: "Codex capacity is unavailable; retry after capacity recovers.",
  rate_limited: "Codex rate limiting prevented this invocation from completing.",
  heartbeat_timeout: "The Codex turn stopped heartbeating and is being reconciled.",
  cancelled: "The Codex turn was cancelled.",
  process_exit: "The Codex invocation did not complete.",
  malformed_jsonl: "Codex returned malformed structured output.",
  schema_mismatch: "Codex returned output outside the required Lead schema.",
  scope_configuration: "The Lead evidence or profile configuration is unavailable.",
  evidence_contradiction: "The Lead evidence failed integrity verification.",
  ownership_ambiguous: "Forge could not prove ownership of the Codex process.",
  internal_persistence: "Forge could not persist the Lead result safely.",
};

export function safeCodexFailureSummary(code: string): string {
  return SAFE_CODEX_FAILURE_SUMMARIES[code] ?? "The Codex Lead turn could not complete safely.";
}

export class CodexTurnSupervisor {
  constructor(private readonly processController: ProcessController = defaultProcessController) {}

  sanitizeLine(line: string): string {
    return sanitizeCodexLine(line);
  }

  failureSummary(code: string): string {
    return safeCodexFailureSummary(code);
  }

  assertSessionIdentity(expected: string | undefined, observed: string | undefined): void {
    if (expected && observed && expected !== observed) throw new Error("Codex session identity changed");
  }

  async cancelOwnedProcess(owned: OwnedProcess, observed?: ProcessInspection): Promise<boolean> {
    void observed;
    const current = await this.processController.inspect(owned.pid);
    if (!current || !processIdentityMatches(owned, current)) return false;
    if (owned.processGroup === undefined || !this.processController.signalGroup || !this.processController.isProcessGroupAlive) return false;
    await this.processController.signalGroup(owned.processGroup, "SIGTERM");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && await this.processController.isProcessGroupAlive(owned.processGroup)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (await this.processController.isProcessGroupAlive(owned.processGroup)) {
      const stillOwned = await this.processController.inspect(owned.pid);
      if (!stillOwned || !processIdentityMatches(owned, stillOwned)) return false;
      await this.processController.signalGroup(owned.processGroup, "SIGKILL");
      for (let attempt = 0; attempt < 100 && await this.processController.isProcessGroupAlive(owned.processGroup); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    return !(await this.processController.isProcessGroupAlive(owned.processGroup));
  }
}
