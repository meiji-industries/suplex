import { json } from "./task-utils.js";
export type PatchOperation = "Edit" | "Add" | "Delete";
export type PatchRow = { kind: "context" | "addition" | "deletion"; text: string; oldLine?: number; newLine?: number };
export type PatchFile = { path: string; operation: PatchOperation; additions: number; deletions: number; rows: PatchRow[] };
export type Patch = { files: PatchFile[] };

const MAX_PATCH_SOURCE = 16_000;
const MAX_FILES = 32;
const MAX_ROWS_PER_FILE = 200;
const MAX_ROW_TEXT = 500;

function stringLiteralAt(source: string, start: number): string | undefined {
  if (source[start] !== "\"") return undefined;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") { index += 1; continue; }
    if (source[index] !== "\"") continue;
    try { const value = json(source.slice(start, index + 1), undefined); return typeof value === "string" ? value : undefined; } catch { return undefined; }
  }
  return undefined;
}

function patchSource(input: string): string | undefined {
  if (input.startsWith("*** Begin Patch")) return input;
  const assignment = /\bconst\s+patch\s*=\s*/.exec(input);
  if (!assignment) return undefined;
  const value = stringLiteralAt(input, assignment.index + assignment[0].length);
  return value?.startsWith("*** Begin Patch") ? value : undefined;
}

function safePath(value: string): string | undefined {
  const path = value.trim();
  return path && !path.startsWith("/") && !/^(?:[A-Za-z]:[\\/]|~[\\/])/.test(path) && !path.split(/[\\/]/).includes("..") ? path : undefined;
}

function startFile(marker: string): PatchFile | undefined {
  const match = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(marker);
  if (!match) return undefined;
  const path = safePath(match[2]!);
  return path ? { path, operation: match[1] === "Update" ? "Edit" : match[1] as "Add" | "Delete", additions: 0, deletions: 0, rows: [] } : undefined;
}

function hunkNumbers(header: string): [number, number] | undefined {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/** Parses only the supported apply-patch grammar after callers redact and bound source. */
export function parseApplyPatch(input: string, sanitize: (value: string, max: number) => string): Patch | undefined {
  const source = patchSource(input);
  if (!source) return undefined;
  const lines = sanitize(source, MAX_PATCH_SOURCE).split("\n");
  if (lines[0] !== "*** Begin Patch" || !lines.includes("*** End Patch")) return undefined;
  const files: PatchFile[] = [];
  let file: PatchFile | undefined;
  let oldLine: number | undefined;
  let newLine: number | undefined;
  for (const line of lines.slice(1)) {
    if (line === "*** End Patch") break;
    const next = startFile(line);
    if (next) {
      if (files.length >= MAX_FILES) return undefined;
      files.push(next);
      file = next;
      oldLine = next.operation === "Delete" ? 1 : undefined;
      newLine = next.operation === "Add" ? 1 : undefined;
      continue;
    }
    if (!file) return undefined;
    if (line.startsWith("*** Move to: ")) {
      const path = safePath(line.slice("*** Move to: ".length));
      if (!path) return undefined;
      file.path = path;
      continue;
    }
    const numbers = hunkNumbers(line);
    if (line.startsWith("@@")) { [oldLine, newLine] = numbers ?? [undefined, undefined]; continue; }
    if (line.startsWith("***")) return undefined;
    const prefix = line[0];
    const kind = prefix === "+" ? "addition" : prefix === "-" ? "deletion" : "context";
    if (file.rows.length >= MAX_ROWS_PER_FILE) return undefined;
    const row: PatchRow = { kind, text: sanitize(prefix === "+" || prefix === "-" || prefix === " " ? line.slice(1) : line, MAX_ROW_TEXT) };
    if (kind !== "addition" && oldLine !== undefined) row.oldLine = oldLine++;
    if (kind !== "deletion" && newLine !== undefined) row.newLine = newLine++;
    if (kind === "addition") file.additions += 1;
    if (kind === "deletion") file.deletions += 1;
    file.rows.push(row);
  }
  return files.length && files.every((item) => item.rows.length > 0) ? { files } : undefined;
}
