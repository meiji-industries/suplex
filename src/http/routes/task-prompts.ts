import { type ZodTypeProvider } from "@fastify/type-provider-zod";
import type { FastifyPluginAsync } from "fastify";

import { ArtifactStore } from "../../artifacts.js";
import type { AuthService } from "../../auth.js";
import type { ForgeConfig } from "../../config.js";
import type { ForgeDatabase } from "../../database.js";
import { isVersionedPromptSet } from "../../prompt-resolution.js";
import { sessionUser } from "../session.js";
import type { TaskService } from "../../tasks.js";
import { jsonRequired } from "../../task-utils.js";
import { loadTaskConfiguration } from "../../task-project-configuration.js";
import { TaskPromptParamsSchema } from "../contracts/prompts.js";

export interface TaskPromptRoutesOptions { auth: AuthService; config: ForgeConfig; database: ForgeDatabase; tasks: TaskService; }

const taskPrompts: FastifyPluginAsync<TaskPromptRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const artifacts = new ArtifactStore(options.config.artifactRoot, options.database);
  typed.addHook("preHandler", async (request, reply) => {
    const user = await sessionUser(options.auth, request, reply, options.config);
    if (!user) return reply.code(401).send({ error: "Authentication required" });
    request.forgeUser = user;
  });
  typed.get("/api/tasks/:taskId/prompts", { schema: { params: TaskPromptParamsSchema } }, async (request, reply) => {
    const task = options.tasks.getTask(request.forgeUser.id, request.params.taskId);
    const configuration = loadTaskConfiguration(options.database.authQuery((db) => db), artifacts, { taskId: task.id, companyId: task.companyId });
    const prompts = configuration.prompts;
    if (!prompts) return reply.send({ version: 1, provenance: {} });
    const artifact = options.database.authQuery((db) => db.prepare("SELECT storage_path FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'task-prompt-set'").get(prompts.artifactId, task.companyId) as { storage_path: string } | undefined);
    if (!artifact) return reply.send({ version: 1, provenance: {} });
    const parsed = jsonRequired(artifacts.getArtifactSync({ companyId: task.companyId, storagePath: artifact.storage_path, sha256: prompts.sha256 }).toString("utf8")) as unknown;
    if (isVersionedPromptSet(parsed)) {
      const provenance = "provenance" in parsed && typeof parsed.provenance === "object" && parsed.provenance !== null ? Object.fromEntries(Object.entries(parsed.provenance)) : {};
      return reply.send({ version: 2, provenance });
    }
    return reply.send({ version: 1, provenance: {} });
  });
};

export default taskPrompts;
