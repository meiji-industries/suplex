import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const probeWorkflows = sqliteTable("probe_workflows", {
  probeId: text("probe_id").primaryKey(),
  workflowId: text("workflow_id").notNull().unique(),
  companyId: text("company_id").notNull(),
  status: text("status", { enum: ["running", "completed"] }).notNull(),
});

export const workerRegistrations = sqliteTable("worker_registrations", {
  workerId: text("worker_id").primaryKey(),
  taskQueue: text("task_queue").notNull(),
  buildId: text("build_id").notNull(),
  heartbeatAt: text("heartbeat_at").notNull(),
});
