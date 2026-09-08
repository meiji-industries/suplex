import { z } from "zod";

const text = z.string().trim().min(1);

export const AdvisorRoleSchema = z.enum(["reviewer", "planner_a", "planner_b", "rater"]);
export type AdvisorRole = z.infer<typeof AdvisorRoleSchema>;
export const REPAIR_RATING_TARGET = 9;

const VerificationSchema = z.enum(["passed", "not_applicable", "missing", "failed"]);
const verified = (verification: z.infer<typeof VerificationSchema>) => verification === "passed" || verification === "not_applicable";

const ReviewerSubmissionSchema = z.object({ approved: z.boolean(), blockingFindings: z.array(text), verification: VerificationSchema, verificationSummary: text, summary: text }).strict();
const RaterSubmissionSchema = z.object({ rating: z.number().int().min(1).max(10), blockingFindings: z.array(text), verification: VerificationSchema, verificationSummary: text, summary: text }).strict();
const PlannerSubmissionSchema = z.object({ summary: text }).strict();

export const ReviewerResultSchema = ReviewerSubmissionSchema.extend({ role: z.literal("reviewer") })
  .refine(result => !result.approved || (result.blockingFindings.length === 0 && verified(result.verification)), "An approval cannot carry blocking findings or missing verification");
export const RaterResultSchema = RaterSubmissionSchema.extend({ role: z.literal("rater") })
  .refine(result => result.rating < REPAIR_RATING_TARGET || (result.blockingFindings.length === 0 && verified(result.verification)), "A rating of 9 or more cannot carry blocking findings or missing verification");
export const PlannerResultSchema = PlannerSubmissionSchema.extend({ role: z.enum(["planner_a", "planner_b"]) });
export const AdvisorResultSchema = z.union([ReviewerResultSchema, RaterResultSchema, PlannerResultSchema]);
export type AdvisorResult = z.infer<typeof AdvisorResultSchema>;
export type ReviewerResult = z.infer<typeof ReviewerResultSchema>;
export type RaterResult = z.infer<typeof RaterResultSchema>;

export type AdvisorReportOutcome = { result: AdvisorResult; invalidReason: null } | { result: null; invalidReason: string };
type ToolEvidence = { name: string; status: "pending" | "running" | "completed" | "error"; output: string | null };

const object = z.record(z.string(), z.unknown());
const SUBMIT_REPORT_TOOL_NAMES = new Set(["submit_report", "forge_advisor_submit_report", "mcp__forge_advisor__submit_report"]);

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

export function advisorReportInputSchema(role: AdvisorRole): Record<string, unknown> {
  if (role === "reviewer") return z.toJSONSchema(ReviewerSubmissionSchema);
  if (role === "rater") return z.toJSONSchema(RaterSubmissionSchema);
  return z.toJSONSchema(PlannerSubmissionSchema);
}
