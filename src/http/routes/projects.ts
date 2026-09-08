import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";

import type { ProjectService } from "../../projects/projects.js";
import { CompanyIdParamsSchema, ProjectIdParamsSchema } from "../contracts/common.js";
import { ModelListResponseSchema, ProjectBodySchema, ProjectCreateBodySchema, ProjectListResponseSchema, ProjectRepositoryDefaultsResponseSchema, ProjectResponseSchema, TaskSourceListResponseSchema, TaskSourceQuerySchema } from "../contracts/projects.js";

export interface ProjectRoutesOptions {
  projects: ProjectService;
}

const projects: FastifyPluginAsync<ProjectRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { projects } = options;
  typed.get("/api/models", { schema: { response: { 200: ModelListResponseSchema } } }, async (request, reply) => reply.send({ models: await projects.listModels(request.forgeUser.id) }));
  typed.get("/api/projects", { schema: { response: { 200: ProjectListResponseSchema } } }, async (request, reply) => reply.send({ projects: projects.listProjects(request.forgeUser.id) }));
  typed.get("/api/companies/:companyId/projects", { schema: { params: CompanyIdParamsSchema, response: { 200: ProjectListResponseSchema } } }, async (request, reply) => reply.send({ projects: projects.listProjects(request.forgeUser.id, request.params.companyId) }));
  typed.post("/api/companies/:companyId/projects", { schema: { params: CompanyIdParamsSchema, body: ProjectCreateBodySchema, response: { 201: ProjectResponseSchema } } }, async (request, reply) => {
    const project = "repositoryUrl" in request.body
      ? await projects.createProjectFromRepository(request.forgeUser.id, request.params.companyId, request.body.repositoryUrl)
      : await projects.createProject(request.forgeUser.id, request.params.companyId, request.body);
    return reply.code(201).send(project);
  });
  typed.get("/api/projects/:projectId", { schema: { params: ProjectIdParamsSchema, response: { 200: ProjectResponseSchema } } }, async (request, reply) => reply.send(projects.getProject(request.forgeUser.id, request.params.projectId)));
  typed.get("/api/projects/:projectId/task-sources", { schema: { params: ProjectIdParamsSchema, querystring: TaskSourceQuerySchema, response: { 200: TaskSourceListResponseSchema } } }, async (request, reply) => reply.send(await projects.discoverTaskSources(request.forgeUser.id, request.params.projectId, request.query.kind)));
  typed.get("/api/projects/:projectId/repository-defaults", { schema: { params: ProjectIdParamsSchema, response: { 200: ProjectRepositoryDefaultsResponseSchema } } }, async (request, reply) => reply.send(await projects.getProjectRepositoryDefaults(request.forgeUser.id, request.params.projectId)));
  typed.patch("/api/projects/:projectId", { schema: { params: ProjectIdParamsSchema, body: ProjectBodySchema, response: { 200: ProjectResponseSchema } } }, async (request, reply) => reply.send(await projects.updateProject(request.forgeUser.id, request.params.projectId, request.body)));
};

export default projects;
