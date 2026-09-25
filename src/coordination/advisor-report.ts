import { z } from "zod";
import { ReviewerResultSchema, RaterResultSchema, PlannerResultSchema } from "./advisor-report-contracts.js";
import type { AdvisorRole, AdvisorResult } from "./advisor-report-contracts.js";
export * from "./advisor-report-contracts.js";

export type AdvisorReportOutcome = { result: AdvisorResult; invalidReason: null } | { result: null; invalidReason: string };
type ToolEvidence = { name: string; status: "pending" | "running" | "completed" | "error"; output: string | null };

const object = z.record(z.string(), z.unknown());
const SUBMIT_REPORT_TOOL_NAMES = new Set(["submit_report", "suplex_advisor_submit_report", "mcp__suplex_advisor__submit_report"]);

function flattenFinding(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const parsed = object.safeParse(value);
  if (!parsed.success) return value;
  return Object.values(parsed.data).filter((field): field is string => typeof field === "string" && field.trim().length > 0).join(": ");
}

function schemaForRole(role: AdvisorRole) {
  return role === "reviewer" ? ReviewerResultSchema : role === "rater" ? RaterResultSchema : PlannerResultSchema;
}

export function validateAdvisorSubmission(role: AdvisorRole, raw: unknown, rejectMismatchedRole = true): AdvisorReportOutcome {
  const parsed = object.safeParse(raw);
  if (!parsed.success) return { result: null, invalidReason: "The report is not an object" };
  if (rejectMismatchedRole && parsed.data.role !== undefined && parsed.data.role !== role) return { result: null, invalidReason: `The submitted report role ${String(parsed.data.role)} does not match the assigned role ${role}` };
  const candidate: Record<string, unknown> = { ...parsed.data, role };
  if (Array.isArray(candidate.blockingFindings)) candidate.blockingFindings = candidate.blockingFindings.map(flattenFinding);
  const result = schemaForRole(role).safeParse(candidate);
  if (!result.success) return { result: null, invalidReason: result.error.issues.map(issue => `${issue.path.join(".") || "report"}: ${issue.message}`).join("; ") };
  return { result: result.data, invalidReason: null };
}

function fencedJsonValues(report: string): string[] {
  const values: string[] = [];
  let current: string[] | null = null;
  for (const line of report.split("\n")) {
    if (current === null) {
      if (/^\s*```json\s*$/.test(line)) current = [];
      continue;
    }
    if (/^\s*```\s*$/.test(line)) {
      values.push(current.join("\n"));
      current = null;
      continue;
    }
    current.push(line);
  }
  if (current !== null) values.push(current.join("\n"));
  return values;
}

function parseJsonObject(textValue: string): { value: unknown; error: null } | { value: null; error: string } {
  try { return { value: JSON.parse(textValue), error: null }; }
  catch (error) { return { value: null, error: error instanceof Error ? error.message : String(error) }; }
}

export function parseAdvisorReport(role: AdvisorRole, report: string): AdvisorReportOutcome {
  const fenced = fencedJsonValues(report);
  const candidate = fenced.at(-1) ?? report.trim();
  if (!candidate) return { result: null, invalidReason: "The report has no JSON object" };
  const parsed = parseJsonObject(candidate);
  if (parsed.error !== null) {
    const prefix = fenced.length ? "The report JSON is not valid JSON" : "The report has no fenced json block or valid raw JSON object";
    return { result: null, invalidReason: `${prefix}: ${parsed.error}` };
  }
  return validateAdvisorSubmission(role, parsed.value, false);
}

type ToolOutputValue = { kind: "error" } | { kind: "value"; value: unknown };

function toolOutputValue(output: string): ToolOutputValue {
  const parsed = parseJsonObject(output);
  if (parsed.error !== null) return { kind: "value", value: undefined };
  const envelope = object.safeParse(parsed.value);
  if (!envelope.success) return { kind: "value", value: parsed.value };
  if (envelope.data.isError === true) return { kind: "error" };
  if ("structuredContent" in envelope.data) return { kind: "value", value: envelope.data.structuredContent };
  const content = z.array(z.object({ type: z.literal("text"), text: z.string() }).passthrough()).safeParse(envelope.data.content);
  if (content.success && content.data.length === 1) {
    const nested = parseJsonObject(content.data[0]!.text);
    if (nested.error === null) return { kind: "value", value: nested.value };
  }
  return { kind: "value", value: parsed.value };
}

export function advisorReportFromTurn(role: AdvisorRole, tools: readonly ToolEvidence[], report: string): AdvisorReportOutcome {
  const submissions = tools.flatMap(tool => SUBMIT_REPORT_TOOL_NAMES.has(tool.name) && tool.status === "completed" && tool.output !== null ? [tool.output] : []);
  if (!submissions.length) return parseAdvisorReport(role, report);
  let latestValid: AdvisorReportOutcome | undefined;
  let latestInvalid: AdvisorReportOutcome | undefined;
  for (const submission of submissions) {
    const decoded = toolOutputValue(submission);
    if (decoded.kind === "error") continue;
    const outcome = validateAdvisorSubmission(role, decoded.value);
    if (outcome.result) latestValid = outcome;
    else latestInvalid = outcome;
  }
  return latestValid ?? latestInvalid ?? parseAdvisorReport(role, report);
}
