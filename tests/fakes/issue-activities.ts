import type { IssueActivities } from "../../src/engine/issue-contracts.js";

/**
 * Build an IssueActivities test double from only the methods a scenario needs.
 * Unlisted activities are simply not registered: if a workflow schedules one,
 * Engine fails that activity task ("Activity function X is not registered"),
 * which is the same observable outcome as the old hand-written throwing stubs.
 * NEVER add methods here to satisfy the compiler — pass overrides instead.
 */
export function createIssueActivitiesFake(overrides: Partial<IssueActivities>): IssueActivities {
  return { ...overrides } as IssueActivities;
}
