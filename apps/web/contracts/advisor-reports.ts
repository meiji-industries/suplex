import { z } from "zod";

const text = z.string().trim().min(1);

export const AdvisorRoleSchema = z.enum(["reviewer", "planner_a", "planner_b", "rater"]);

export type AdvisorRole = z.infer<typeof AdvisorRoleSchema>;

export const REPAIR_RATING_TARGET = 9;

const VerificationSchema = z.enum(["passed", "not_applicable", "pending", "missing", "failed"]);

const verified = (verification: z.infer<typeof VerificationSchema>) => verification === "passed" || verification === "not_applicable" || verification === "pending";

const ReviewerSubmissionSchema = z.object({ approved: z.boolean(), blockingFindings: z.array(text), verification: VerificationSchema, verificationSummary: text, summary: text }).strict();

const RaterSubmissionSchema = z.object({ rating: z.number().int().min(1).max(10), blockingFindings: z.array(text), verification: VerificationSchema, verificationSummary: text, summary: text }).strict();

export const ReviewerResultSchema = ReviewerSubmissionSchema.extend({ role: z.literal("reviewer") })
  .refine(result => !result.approved || (result.blockingFindings.length === 0 && verified(result.verification)), "An approval cannot carry blocking findings or missing verification");

export const RaterResultSchema = RaterSubmissionSchema.extend({ role: z.literal("rater") })
  .refine(result => result.rating < REPAIR_RATING_TARGET || (result.blockingFindings.length === 0 && verified(result.verification)), "A rating of 9 or more cannot carry blocking findings or missing verification");
