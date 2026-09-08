import type { TaskExecution } from "./task-execution-contracts.js";

type Tool = TaskExecution["sessions"][number]["tools"][number];
type Field = "input" | "output" | "error";

export interface WorkerEvidenceChunk {
  toolId: string;
  name: string;
  status: Tool["status"];
  field: Field;
  encoding: "json" | "text";
  offset: number;
  text: string;
  complete: boolean;
}

const fields: Field[] = ["input", "output", "error"];

function cursor(tool: number, field: number, offset: number): string {
  return `${tool}:${field}:${offset}`;
}

function parseCursor(value: string | undefined): { tool: number; field: number; offset: number } {
  if (value === undefined) return { tool: 0, field: 0, offset: 0 };
  const match = /^(\d+):(\d+):(\d+)$/.exec(value);
  if (!match) throw new Error("Worker evidence cursor is invalid");
  const result = { tool: Number(match[1]), field: Number(match[2]), offset: Number(match[3]) };
  if (!Number.isSafeInteger(result.tool) || !Number.isSafeInteger(result.field) || !Number.isSafeInteger(result.offset) || result.field >= fields.length) throw new Error("Worker evidence cursor is invalid");
  return result;
}

function fieldText(tool: Tool, field: Field): string {
  if (field === "input") return JSON.stringify(tool.input);
  return tool[field] ?? "null";
}

/** Pages native evidence by content characters so one verbose command cannot flood a Coordinator turn. */
export function pageWorkerEvidence(tools: Tool[], requestedCursor: string | undefined, maxCharacters: number): { chunks: WorkerEvidenceChunk[]; nextCursor: string | null } {
  const start = parseCursor(requestedCursor);
  if (start.tool > tools.length || start.tool === tools.length && (start.field !== 0 || start.offset !== 0)) throw new Error("Worker evidence cursor is out of range");
  const chunks: WorkerEvidenceChunk[] = [];
  let remaining = maxCharacters;
  let toolIndex = start.tool;
  let fieldIndex = start.field;
  let offset = start.offset;
  while (toolIndex < tools.length && remaining > 0) {
    const tool = tools[toolIndex]!;
    const field = fields[fieldIndex]!;
    const value = fieldText(tool, field);
    if (offset > value.length) throw new Error("Worker evidence cursor is out of range");
    const text = value.slice(offset, offset + remaining);
    const complete = offset + text.length >= value.length;
    chunks.push({ toolId: tool.id, name: tool.name, status: tool.status, field, encoding: field === "input" ? "json" : "text", offset, text, complete });
    remaining -= text.length;
    if (!complete) return { chunks, nextCursor: cursor(toolIndex, fieldIndex, offset + text.length) };
    offset = 0;
    fieldIndex += 1;
    if (fieldIndex === fields.length) { fieldIndex = 0; toolIndex += 1; }
  }
  return { chunks, nextCursor: toolIndex < tools.length ? cursor(toolIndex, fieldIndex, offset) : null };
}
