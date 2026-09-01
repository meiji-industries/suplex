import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workerRegistrations = sqliteTable("worker_registrations", {
  workerId: text("worker_id").primaryKey(),
  taskQueue: text("task_queue").notNull(),
  buildId: text("build_id").notNull(),
  heartbeatAt: text("heartbeat_at").notNull(),
});
