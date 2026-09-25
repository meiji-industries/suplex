import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";
import { IssueAssociationSchema } from "../../tasks/issue-association.js";

import { checkRepositoryConnection } from "../../projects/repository-connection.js";
import type { ProjectService } from "../../projects/projects.js";
import { CompanyIdParamsSchema, ProjectIdParamsSchema } from "../contracts/common.js";
import { ProjectRepositoryStatusSchema, ModelListResponseSchema, ProjectBodySchema, ProjectCreateBodySchema, ProjectListResponseSchema, ProjectPatchBodySchema, ProjectProviderInstanceListResponseSchema, ProjectRepositoryDefaultsResponseSchema, ProjectResponseSchema, TaskSourceListResponseSchema, TaskSourceQuerySchema } from "../contracts/projects.js";

export interface ProjectRoutesOptions {
  projects: ProjectService;
}

const projects: FastifyPluginAsync<ProjectRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { projects } = options;
  typed.get("/api/models", { schema: { response: { 200: ModelListResponseSchema } } }, async (request, reply) => reply.send({ models: await projects.listModels(request.suplexUser.id) }));
  typed.get("/api/projects", { schema: { response: { 200: ProjectListResponseSchema } } }, async (request, reply) => reply.send({ projects: projects.listProjects(request.suplexUser.id) }));
  typed.get("/api/companies/:companyId/projects", { schema: { params: CompanyIdParamsSchema, response: { 200: ProjectListResponseSchema } } }, async (request, reply) => reply.send({ projects: projects.listProjects(request.suplexUser.id, request.params.companyId) }));
  typed.post("/api/companies/:companyId/projects", { schema: { params: CompanyIdParamsSchema, body: ProjectCreateBodySchema, response: { 201: ProjectResponseSchema } } }, async (request, reply) => {
    const project = "repositoryUrl" in request.body
      ? await projects.createProjectFromRepository(request.suplexUser.id, request.params.companyId, request.body.repositoryUrl, request.body)
      : "repositoryName" in request.body
        ? await projects.createProjectWithNewRepository(request.suplexUser.id, request.params.companyId, request.body.repositoryName, request.body)
      : await projects.createProject(request.suplexUser.id, request.params.companyId, request.body);
    return reply.code(201).send(project);
  });
  typed.get("/api/companies/:companyId/repository-owners", { schema: { params: CompanyIdParamsSchema, response: { 200: z.object({ owners: z.array(z.string()) }) } } }, async (request, reply) => reply.send({ owners: await projects.listGithubOwners(request.suplexUser.id, request.params.companyId) }));
  typed.get("/api/companies/:companyId/repository-owners/:owner/repositories", { schema: {
    // A GitHub login: letters, numbers, and single dashes, never a leading dash, so it cannot read as a CLI flag.
    params: CompanyIdParamsSchema.extend({ owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/) }),
    response: { 200: z.object({ repositories: z.array(z.object({ name: z.string(), defaultBranch: z.string() })) }) },
  } }, async (request, reply) => reply.send({ repositories: await projects.listGithubRepositories(request.suplexUser.id, request.params.companyId, request.params.owner) }));
  typed.get("/api/projects/:projectId", { schema: { params: ProjectIdParamsSchema, response: { 200: ProjectResponseSchema } } }, async (request, reply) => reply.send(projects.getProject(request.suplexUser.id, request.params.projectId)));
  typed.get("/api/projects/:projectId/repository-status", { schema: { params: ProjectIdParamsSchema, response: { 200: ProjectRepositoryStatusSchema } } }, async (request, reply) => {
    const project = projects.getProject(request.suplexUser.id, request.params.projectId);
    const result = await checkRepositoryConnection(project);
    projects.getProject(request.suplexUser.id, request.params.projectId);
    return reply.header("Cache-Control", "no-store").send(result);
  });
  typed.get("/api/projects/:projectId/issues", { schema: {
    params: ProjectIdParamsSchema,
    querystring: z.object({ query: z.string().max(200).default("") }), // bound: provider autocomplete query, not authored task text
    response: { 200: z.object({ issues: z.array(IssueAssociationSchema) }) },
  } }, async (request, reply) => reply.send({ issues: await projects.searchIssues(request.suplexUser.id, request.params.projectId, request.query.query) }));
  typed.get("/api/projects/:projectId/task-sources", { schema: { params: ProjectIdParamsSchema, querystring: TaskSourceQuerySchema, response: { 200: TaskSourceListResponseSchema } } }, async (request, reply) => reply.send(await projects.discoverTaskSources(request.suplexUser.id, request.params.projectId, request.query.kind)));
  typed.get("/api/projects/:projectId/repository-defaults", { schema: { params: ProjectIdParamsSchema, response: { 200: ProjectRepositoryDefaultsResponseSchema } } }, async (request, reply) => reply.send(await projects.getProjectRepositoryDefaults(request.suplexUser.id, request.params.projectId)));
  typed.get("/api/projects/:projectId/provider-instances", { schema: { params: ProjectIdParamsSchema, response: { 200: ProjectProviderInstanceListResponseSchema } } }, async (request, reply) => reply.send({ instances: projects.listProjectProviderInstances(request.suplexUser.id, request.params.projectId) }));
  typed.patch("/api/projects/:projectId", { schema: { params: ProjectIdParamsSchema, body: ProjectPatchBodySchema, response: { 200: ProjectResponseSchema } } }, async (request, reply) => {
    const full = ProjectBodySchema.safeParse(request.body);
    return reply.send(full.success
      ? await projects.updateProject(request.suplexUser.id, request.params.projectId, full.data)
      : await projects.patchProject(request.suplexUser.id, request.params.projectId, request.body));
  });
};

export default projects;
