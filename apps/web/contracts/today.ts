import { z } from "zod";

import type { TodayResponse } from "./generated/TodayResponse.js";
import type { TodayTask } from "./generated/TodayTask.js";
import { TaskControlStatusSchema } from "./task-control.js";
import { DeliveryTargetSchema, TaskHumanQuestionSchema } from "./tasks.js";

const id = z.string().min(1);
const instant = z.string().datetime({ offset: true });

export const TodayTaskSchema = z.object({
  taskId: id,
  title: z.string(),
  companyId: id,
  companyName: z.string(),
  projectId: id,
  projectName: z.string(),
  issueKey: z.string().nullable(),
  status: TaskControlStatusSchema,
  deliveryTarget: DeliveryTargetSchema,
  lastUpdated: instant,
  shippedAt: instant.nullable(),
  humanQuestion: TaskHumanQuestionSchema.nullable(),
}).strict();

export const TodayResponseSchema = z.object({
  generatedAt: instant,
  weekStartsAt: instant,
  weekEndsAt: instant,
  companies: z.array(z.object({ id, name: z.string() }).strict()),
  needsYou: z.array(TodayTaskSchema),
  inProgress: z.array(TodayTaskSchema),
  shippedThisWeek: z.array(TodayTaskSchema),
  spendByCompany: z.array(z.object({
    companyId: id,
    companyName: z.string(),
    knownCostUsd: z.number().finite().nonnegative().nullable(),
    measuredMessages: z.number().int().nonnegative(),
    unpricedMessages: z.number().int().nonnegative(),
    partial: z.boolean(),
    subsidized: z.boolean(),
    totalTokens: z.number().int().nonnegative(),
  }).strict()),
}).strict() satisfies z.ZodType<TodayResponse>;

export type Today = TodayResponse;
export type { TodayTask };
