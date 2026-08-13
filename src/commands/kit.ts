import type { z } from "zod";

import type { MaterialityEvidenceSubject, PlanBlockerSubject, PlanDecisionSubject, PlanSubject, SupplementalReviewSubject } from "../plan-governance.js";

export type CommandFamily = "start" | "plan" | "bespoke";

export interface CommandUiContext {
  expectedRevision: number;
  reviewerProfileId?: string;
  originalPlanSubject?: PlanSubject | null;
  finalPlanSubject?: PlanSubject | null;
  materialityEvidence?: MaterialityEvidenceSubject | null;
  planBlockerSubject?: PlanBlockerSubject | null;
}

export type CommandSubject =
  | { kind: "plan_decision"; value: PlanDecisionSubject }
  | { kind: "supplemental_review"; value: SupplementalReviewSubject }
  | { kind: "plan_blocker"; value: PlanBlockerSubject };

export interface IssueCommandDescriptor<Name extends string = string, Body extends z.ZodType = z.ZodType> {
  name: Name;
  /** HTTP endpoint segment and frontend action id, e.g. "publish-draft". null = no HTTP route (internal command). */
  slug: string | null;
  /** FROZEN Temporal update name, e.g. "publishDraft". Pinned by tests/temporal-contract-pins.test.ts. */
  updateName: string;
  label: string;
  /** Which client pipeline executes it. "bespoke" descriptors keep hand-written routes/wrappers. */
  family: CommandFamily;
  /** FROZEN durableCommand kind string (commandId derivation). null for commands that never used durableCommand. */
  durableCommandKind: string | null;
  /** First argument to assertPayloadWithinLimit, preserved verbatim from the old wrappers. */
  payloadLabel: string;
  /** HTTP request body schema; null when slug is null or family is "bespoke". */
  body: Body | null;
  note: "required" | "none";
  idempotency: "required" | "none";
  /**
   * UI availability + subject computation, transplanted verbatim from the matching
   * `case` in src/task-commands.ts `descriptor()`. Return undefined to hide the command,
   * or the subject payload to attach. Commands without a case body return {}.
   */
  uiSubject?: (context: CommandUiContext) => { subject?: CommandSubject } | undefined;
}

export function defineIssueCommand<Name extends string, Body extends z.ZodType>(descriptor: IssueCommandDescriptor<Name, Body>): IssueCommandDescriptor<Name, Body> {
  return descriptor;
}
