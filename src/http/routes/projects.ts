import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";

import type { ProjectService } from "../../projects.js";
import type { ProjectRole } from "../../projects.js";
import { CompanyIdParamsSchema, ProjectIdParamsSchema } from "../contracts/common.js";
import { ProfileListResponseSchema, ProjectBodySchema, ProjectListResponseSchema, ProjectResponseSchema } from "../contracts/projects.js";

export interface ProjectRoutesOptions {
  projects: ProjectService;
}

function roleDefaults(value: { lead?: string | undefined; developer?: string | undefined; reviewer?: string | undefined }): Partial<Record<ProjectRole, string>> {
  const result: Partial<Record<ProjectRole, string>> = {};
  if (value.lead !== undefined) result.lead = value.lead;
  if (value.developer !== undefined) result.developer = value.developer;
  if (value.reviewer !== undefined) result.reviewer = value.reviewer;
  return result;
}

const projects: FastifyPluginAsync<ProjectRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { projects } = options;
  typed.get("/api/profiles", { schema: { response: { 200: ProfileListResponseSchema } } }, async (request, reply) => reply.send({ profiles: projects.listProfiles(request.forgeUser.id) }));
  typed.get("/api/projects", { schema: { response: { 200: ProjectListResponseSchema } } }, async (request, reply) => reply.send({ projects: projects.listProjects(request.forgeUser.id) }));
  typed.get("/api/companies/:companyId/projects", { schema: { params: CompanyIdParamsSchema, response: { 200: ProjectListResponseSchema } } }, async (request, reply) => reply.send({ projects: projects.listProjects(request.forgeUser.id, request.params.companyId) }));
  typed.post("/api/companies/:companyId/projects", { schema: { params: CompanyIdParamsSchema, body: ProjectBodySchema, response: { 201: ProjectResponseSchema } } }, async (request, reply) => reply.code(201).send(await projects.createProject(request.forgeUser.id, request.params.companyId, { ...request.body, roleDefaults: roleDefaults(request.body.roleDefaults) })));
  typed.get("/api/projects/:projectId", { schema: { params: ProjectIdParamsSchema, response: { 200: ProjectResponseSchema } } }, async (request, reply) => reply.send(projects.getProject(request.forgeUser.id, request.params.projectId)));
  typed.patch("/api/projects/:projectId", { schema: { params: ProjectIdParamsSchema, body: ProjectBodySchema, response: { 200: ProjectResponseSchema } } }, async (request, reply) => reply.send(await projects.updateProject(request.forgeUser.id, request.params.projectId, { ...request.body, roleDefaults: roleDefaults(request.body.roleDefaults) })));
  typed.post("/api/projects/:projectId/activate", { schema: { params: ProjectIdParamsSchema, response: { 200: ProjectResponseSchema } } }, async (request, reply) => reply.send(await projects.activateProject(request.forgeUser.id, request.params.projectId)));
  typed.post("/api/projects/:projectId/pause", { schema: { params: ProjectIdParamsSchema, response: { 200: ProjectResponseSchema } } }, async (request, reply) => reply.send(await projects.pauseProject(request.forgeUser.id, request.params.projectId)));
  typed.post("/api/projects/:projectId/archive", { schema: { params: ProjectIdParamsSchema, response: { 200: ProjectResponseSchema } } }, async (request, reply) => reply.send(await projects.archiveProject(request.forgeUser.id, request.params.projectId)));
};

export default projects;
