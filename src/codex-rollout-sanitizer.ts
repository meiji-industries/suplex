import { redact } from "./logging.js";
import { jsonRequired } from "./task-utils.js";

const maxText = 32_000;
const maxLine = 128_000;

function safeText(value: string): string {
  return String(redact(value))
    .replace(/(?:Bearer\s+[^\s,;]+|(?:gho_|github_pat_|sk-)[A-Za-z0-9_-]+)/gi, "[REDACTED]")
    .replace(/(?:\/Users\/|\/home\/|\/tmp\/|[A-Za-z]:\\)[^\s"']+/g, "[PATH]")
    .slice(0, maxText);
}

export function sanitizeCodexLine(line: string): string {
  try {
    const value = jsonRequired(line);
    if (!value || typeof value !== "object") return JSON.stringify({ type: "text", text: safeText(line) });
    const event = value as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "unknown";
    if (type.includes("reasoning")) return JSON.stringify({ type: "reasoning", redacted: true });
    if (type === "error") return JSON.stringify({ type, error: { message: typeof event.message === "string" ? safeText(event.message) : "Codex returned an error" } });
    return JSON.stringify({ type }).slice(0, maxLine);
  } catch {
    return JSON.stringify({ type: "text", text: safeText(line) }).slice(0, maxLine);
  }
}
