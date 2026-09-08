import type { TaskExecution } from "../tasks/execution/contracts.js";

type Tool = TaskExecution["sessions"][number]["tools"][number];
export type WorkerEvidenceField = "input" | "output" | "error";
export type WorkerEvidencePosition = "head" | "tail";

export interface WorkerEvidenceQuery {
  toolId?: string | undefined;
  field?: WorkerEvidenceField | undefined;
  position?: WorkerEvidencePosition | undefined;
  cursor?: string | undefined;
  maxCharacters: number;
}

interface EvidenceExcerpt {
  text: string;
  totalCharacters: number;
  offset: number;
  complete: boolean;
  truncatedBefore: boolean;
  truncatedAfter: boolean;
}

interface IndexExcerpt {
  text: string;
  totalCharacters: number;
  truncated: boolean;
}

interface IndexedTool {
  toolId: string;
  name: string;
  status: Tool["status"];
  inputPreview: IndexExcerpt;
  command: IndexExcerpt | null;
  outputTail: IndexExcerpt;
  errorTail: IndexExcerpt;
}

export type WorkerEvidenceResult = {
  kind: "index";
  tools: IndexedTool[];
  nextCursor: string | null;
  readMore: string | null;
} | {
  kind: "tool";
  tool: { toolId: string; name: string; status: Tool["status"] };
  field: WorkerEvidenceField;
  position: WorkerEvidencePosition;
  available: boolean;
  evidence: EvidenceExcerpt;
  nextCursor: string | null;
  readMore: string | null;
};

const INDEX_INPUT_CHARACTERS = 240;
const INDEX_COMMAND_CHARACTERS = 240;
const INDEX_OUTPUT_CHARACTERS = 240;
const INDEX_ERROR_CHARACTERS = 240;

function excerpt(value: string, position: WorkerEvidencePosition, maxCharacters: number, offset = 0): EvidenceExcerpt {
  const start = position === "tail" ? Math.max(0, value.length - maxCharacters) : offset;
  if (start > value.length) throw new Error("Worker evidence cursor is out of range");
  const text = value.slice(start, start + maxCharacters);
  const end = start + text.length;
  return { text, totalCharacters: value.length, offset: start, complete: start === 0 && end === value.length, truncatedBefore: start > 0, truncatedAfter: end < value.length };
}

function fieldValue(tool: Tool, field: WorkerEvidenceField): { available: boolean; text: string } {
  if (field === "input") return { available: true, text: JSON.stringify(tool.input) ?? "" };
  const value = tool[field];
  return { available: value !== null, text: value ?? "" };
}

function indexExcerpt(value: string, position: WorkerEvidencePosition, maxCharacters: number): IndexExcerpt {
  const item = excerpt(value, position, maxCharacters);
  return { text: item.text, totalCharacters: item.totalCharacters, truncated: !item.complete };
}

function cursorOffset(cursor: string | undefined, prefix: "index" | "field"): number {
  if (cursor === undefined) return 0;
  const match = new RegExp(`^${prefix}:(\\d+)$`).exec(cursor);
  if (!match) throw new Error(`Worker evidence cursor is invalid for ${prefix} access`);
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset)) throw new Error("Worker evidence cursor is invalid");
  return offset;
}

function indexTool(tool: Tool, previewCharacters = Number.POSITIVE_INFINITY): IndexedTool {
  const input = JSON.stringify(tool.input) ?? "";
  const command = tool.input.command;
  return {
    toolId: tool.id,
    name: tool.name,
    status: tool.status,
    inputPreview: indexExcerpt(input, "head", Math.min(INDEX_INPUT_CHARACTERS, previewCharacters)),
    command: typeof command === "string" ? indexExcerpt(command, "head", Math.min(INDEX_COMMAND_CHARACTERS, previewCharacters)) : null,
    outputTail: indexExcerpt(tool.output ?? "", "tail", Math.min(INDEX_OUTPUT_CHARACTERS, previewCharacters)),
    errorTail: indexExcerpt(tool.error ?? "", "tail", Math.min(INDEX_ERROR_CHARACTERS, previewCharacters)),
  };
}

function indexResult(tools: IndexedTool[], nextIndex: number | null): Extract<WorkerEvidenceResult, { kind: "index" }> {
  const nextCursor = nextIndex === null ? null : `index:${nextIndex}`;
  return { kind: "index", tools, nextCursor, readMore: nextCursor ? `Continue the compact tool index with cursor ${nextCursor}.` : null };
}

function evidenceIndex(tools: Tool[], query: WorkerEvidenceQuery): WorkerEvidenceResult {
  const start = cursorOffset(query.cursor, "index");
  if (start > tools.length) throw new Error("Worker evidence cursor is out of range");
  const indexed: IndexedTool[] = [];
  let toolIndex = start;
  for (; toolIndex < tools.length; toolIndex += 1) {
    let candidate = indexTool(tools[toolIndex]!);
    const nextIndex = toolIndex + 1 < tools.length ? toolIndex + 1 : null;
    if (indexed.length === 0) {
      for (let previewCharacters = 200; JSON.stringify(indexResult([candidate], nextIndex)).length > query.maxCharacters && previewCharacters >= 0; previewCharacters -= 20) {
        candidate = indexTool(tools[toolIndex]!, previewCharacters);
      }
      if (JSON.stringify(indexResult([candidate], nextIndex)).length > query.maxCharacters) throw new Error("Worker evidence budget is too small for tool index metadata");
    }
    if (JSON.stringify(indexResult([...indexed, candidate], nextIndex)).length > query.maxCharacters) break;
    indexed.push(candidate);
  }
  return indexResult(indexed, toolIndex < tools.length ? toolIndex : null);
}

function selectedEvidence(tools: Tool[], query: WorkerEvidenceQuery): WorkerEvidenceResult {
  const tool = tools.find(candidate => candidate.id === query.toolId);
  if (!tool) throw new Error(`Worker evidence tool ${query.toolId} does not exist`);
  const field = query.field ?? "output";
  const position = query.position ?? "tail";
  if (position === "tail" && query.cursor !== undefined) throw new Error("Worker evidence cursor is only valid for head access");
  const offset = position === "head" ? cursorOffset(query.cursor, "field") : 0;
  const value = fieldValue(tool, field);
  const evidence = excerpt(value.text, position, query.maxCharacters, offset);
  const nextCursor = position === "head" && evidence.truncatedAfter ? `field:${evidence.offset + evidence.text.length}` : null;
  const readMore = nextCursor
    ? `Continue this ${field} field with position head and cursor ${nextCursor}.`
    : evidence.truncatedBefore
      ? `Read this ${field} field from the beginning with position head.`
      : null;
  return {
    kind: "tool",
    tool: { toolId: tool.id, name: tool.name, status: tool.status },
    field,
    position,
    available: value.available,
    evidence,
    nextCursor,
    readMore,
  };
}

export function readWorkerEvidence(tools: Tool[], query: WorkerEvidenceQuery): WorkerEvidenceResult {
  return query.toolId === undefined ? evidenceIndex(tools, query) : selectedEvidence(tools, query);
}
