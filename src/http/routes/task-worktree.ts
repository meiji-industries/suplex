import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";

import { runCommand, type CommandRunResult } from "../../command-runner.js";
import type { ForgeDatabase } from "../../database.js";
import type { TaskService } from "../../tasks.js";
import type { ForgeConfig } from "../../config.js";
import { configuredEditorLauncher, worktreeLauncher, worktreeLaunchers, type ConfiguredEditorLauncher, type WorktreeLauncher } from "../../worktree-open.js";
import { TaskIdParamsSchema } from "../contracts/common.js";
import { WorktreeAppsResponseSchema, WorktreeAppSchema } from "../contracts/tasks.js";
import { isLoopbackHost } from "../session.js";

const WorktreeOpenBodySchema = z.object({ app: z.union([WorktreeAppSchema, z.literal("editor")]) });
const WorktreeOpenResponseSchema = z.object({ ok: z.boolean(), error: z.string().optional() });

export interface TaskWorktreeRoutesOptions {
  tasks: TaskService;
  database: ForgeDatabase;
  config?: Pick<ForgeConfig, "port">;
  runCommand?: typeof runCommand;
  launchers?: () => WorktreeLauncher[];
  editorLauncher?: () => ConfiguredEditorLauncher | undefined;
}

function isLoopbackPeer(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isDirectLoopbackRequest(request: { headers: { host?: string | string[] | undefined; forwarded?: unknown; "x-forwarded-for"?: unknown; "x-forwarded-host"?: unknown; "x-real-ip"?: unknown }; socket: { remoteAddress: string | undefined } }, config: Pick<ForgeConfig, "port"> | undefined): boolean {
  if (!config || !isLoopbackHost(config, typeof request.headers.host === "string" ? request.headers.host : undefined)) return false;
  if (request.headers.forwarded !== undefined || request.headers["x-forwarded-for"] !== undefined || request.headers["x-forwarded-host"] !== undefined || request.headers["x-real-ip"] !== undefined) return false;
  return isLoopbackPeer(request.socket.remoteAddress);
}

const taskWorktree: FastifyPluginAsync<TaskWorktreeRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const execute = options.runCommand ?? runCommand;
  const available = options.launchers ?? worktreeLaunchers;
  const local = (request: Parameters<typeof isDirectLoopbackRequest>[0]) => isDirectLoopbackRequest(request, options.config);
  typed.get("/api/tasks/:taskId/worktree/apps", { schema: { params: TaskIdParamsSchema, response: { 200: WorktreeAppsResponseSchema, 404: z.object({ error: z.string() }) } } }, async (request, reply) => {
    const task = options.tasks.getTask(request.forgeUser.id, request.params.taskId);
    if (!task.worktree) return reply.code(404).send({ error: "Worktree not found" });
    if (!local(request)) return { apps: [] };
    return { apps: available().map(({ id, label }) => ({ id, label })) };
  });
  typed.post("/api/tasks/:taskId/worktree/open", { schema: { params: TaskIdParamsSchema, body: WorktreeOpenBodySchema, response: { 200: WorktreeOpenResponseSchema, 403: WorktreeOpenResponseSchema, 404: z.object({ error: z.string() }), 501: WorktreeOpenResponseSchema } } }, async (request, reply) => {
    const task = options.tasks.getTask(request.forgeUser.id, request.params.taskId);
    const worktree = task.worktree ? { worktreePath: task.worktree.path } : null;
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });
    // A remote browser can still copy its path, but must never cause a local desktop launch.
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Opening a worktree is available only from the Forge host" });
    const launcher = worktreeLauncher(request.body.app, available(), options.editorLauncher?.() ?? configuredEditorLauncher());
    if (!launcher) return reply.code(501).send({ ok: false, error: "This application is not available on this Forge host" });
    let result: CommandRunResult;
    try {
      result = await execute({ taskId: request.params.taskId, stepId: null, command: launcher.command, args: launcher.args(worktree.worktreePath), ...(launcher.cwd ? { cwd: launcher.cwd(worktree.worktreePath) } : {}) });
    } catch (error) {
      return reply.send({ ok: false, error: error instanceof Error ? error.message : "Could not open the worktree" });
    }
    if (result.exitCode !== 0) return reply.send({ ok: false, error: result.stderr.trim() || result.stdout.trim() || "Could not open the worktree" });
    options.database.authQuery((db) => db.prepare("INSERT INTO forge_audit_events (id, actor_user_id, action, company_id, metadata_json, created_at) VALUES (?, ?, 'worktree_opened', ?, ?, ?)").run(randomUUID(), request.forgeUser.id, task.companyId, JSON.stringify({ taskId: request.params.taskId, app: launcher.id }), new Date().toISOString()));
    return reply.send({ ok: true });
  });
};

export default taskWorktree;
