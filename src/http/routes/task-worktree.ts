import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";

import { runCommand, type CommandRunResult } from "../../command-runner.js";
import type { ForgeDatabase } from "../../database.js";
import type { TaskService } from "../../tasks.js";
import { TaskIdParamsSchema } from "../contracts/common.js";

const WorktreeOpenBodySchema = z.object({ app: z.enum(["editor", "terminal"]) });
const WorktreeOpenResponseSchema = z.object({ ok: z.boolean(), error: z.string().optional() });

export interface TaskWorktreeRoutesOptions {
  tasks: TaskService;
  database: ForgeDatabase;
  runCommand?: typeof runCommand;
}

const taskWorktree: FastifyPluginAsync<TaskWorktreeRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const execute = options.runCommand ?? runCommand;
  typed.post("/api/tasks/:taskId/worktree/open", { schema: { params: TaskIdParamsSchema, body: WorktreeOpenBodySchema, response: { 200: WorktreeOpenResponseSchema, 404: z.object({ error: z.string() }), 501: WorktreeOpenResponseSchema } } }, async (request, reply) => {
    const task = options.tasks.getTask(request.forgeUser.id, request.params.taskId);
    const worktree = options.database.authQuery((db) => db.prepare("SELECT worktree_path AS worktreePath FROM forge_issue_worktrees WHERE task_id = ? AND company_id = ? ORDER BY reserved_at DESC LIMIT 1").get(request.params.taskId, task.companyId) as { worktreePath: string } | undefined);
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });
    if (request.body.app === "terminal" && !["darwin", "linux"].includes(process.platform)) return reply.code(501).send({ ok: false, error: "Opening a terminal is unavailable on this Forge host" });
    const command = request.body.app === "terminal" ? process.platform === "darwin" ? "open" : "x-terminal-emulator" : process.env.FORGE_EDITOR_COMMAND ?? "code";
    const args = request.body.app === "terminal" && process.platform === "darwin" ? ["-a", "Terminal", worktree.worktreePath] : request.body.app === "editor" ? [worktree.worktreePath] : [];
    let result: CommandRunResult;
    try {
      result = await execute({ taskId: request.params.taskId, stepId: null, command, args, ...(request.body.app === "terminal" && process.platform === "linux" ? { cwd: worktree.worktreePath } : {}) });
    } catch (error) {
      return reply.send({ ok: false, error: error instanceof Error ? error.message : "Could not open the worktree" });
    }
    if (result.exitCode !== 0) return reply.send({ ok: false, error: result.stderr.trim() || result.stdout.trim() || "Could not open the worktree" });
    options.database.authQuery((db) => db.prepare("INSERT INTO forge_audit_events (id, actor_user_id, action, company_id, metadata_json, created_at) VALUES (?, ?, 'worktree_opened', ?, ?, ?)").run(randomUUID(), request.forgeUser.id, task.companyId, JSON.stringify({ taskId: request.params.taskId, app: request.body.app }), new Date().toISOString()));
    return reply.send({ ok: true });
  });
};

export default taskWorktree;
