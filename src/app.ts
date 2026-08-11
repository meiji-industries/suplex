import { readFile } from "node:fs/promises";

import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";

import { AuthFailure, AuthService, type AuthUser } from "./auth.js";
import type { ForgeConfig } from "./config.js";
import { inspectHostHealth, type HealthSnapshot, type HostHealthDependencies } from "./health.js";
import { ProjectFailure, ProjectService, type ProjectInput, type ProjectRole } from "./projects.js";
import { TaskFailure, TaskService, type TaskEvent, type TaskInput } from "./tasks.js";
import { HealthSnapshotSchema } from "./schemas.js";
import { renderApplicationPage, renderHealthPage } from "./ui.js";

async function readFrontendAsset(filename: string): Promise<Buffer> {
  const locations = [
    new URL(`../web/${filename}`, import.meta.url),
    new URL(`../dist/web/${filename}`, import.meta.url),
  ];
  for (const location of locations) {
    try {
      return Buffer.from(await readFile(location));
    } catch {
      // Try the source-tree location when running through tsx, then the compiled location.
    }
  }
  throw new Error(`Frontend asset is not built: ${filename}`);
}

export interface AppDependencies {
  config: ForgeConfig;
  health: HostHealthDependencies;
  getHealth?: () => Promise<HealthSnapshot>;
  auth?: AuthService;
  projects?: ProjectService;
  tasks?: TaskService;
}

export function createApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(cookie);
  const getHealth = dependencies.getHealth ?? (() => inspectHostHealth(dependencies.config, dependencies.health));
  const readHealth = async (): Promise<HealthSnapshot> => HealthSnapshotSchema.parse(await getHealth());
  const auth = dependencies.auth;
  const projects = dependencies.projects;
  const tasks = dependencies.tasks;
  const sessionUser = async (request: { cookies: Record<string, string | undefined> }): Promise<AuthUser | undefined> => auth?.getUserBySession(request.cookies.forge_session ?? "");
  const sendAuthError = (reply: { code: (statusCode: number) => { send: (body: object) => unknown } }, error: unknown): unknown => {
    if (error instanceof AuthFailure) {
      return reply.code(error.statusCode).send({ error: error.publicMessage });
    }
    return reply.code(400).send({ error: "Request failed" });
  };
  const requestBody = (request: { body: unknown }): Record<string, unknown> => {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
      return {};
    }
    return request.body as Record<string, unknown>;
  };
  const textBody = (request: { body: unknown }, key: string): string => {
    const value = requestBody(request)[key];
    return typeof value === "string" ? value : "";
  };
  const requireUser = async (request: { cookies: Record<string, string | undefined> }, reply: { code: (statusCode: number) => { send: (body: object) => unknown } }): Promise<AuthUser | undefined> => {
    const user = await sessionUser(request);
    if (!user) {
      reply.code(401).send({ error: "Authentication required" });
      return undefined;
    }
    return user;
  };
  const setSessionCookie = (reply: { setCookie: (name: string, value: string, options: { httpOnly: boolean; sameSite: "lax"; secure: boolean; path: string; maxAge: number }) => unknown }, sessionToken: string): void => {
    reply.setCookie("forge_session", sessionToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: dependencies.config.reachableAddress.startsWith("https:"),
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
    });
  };

  app.get("/", async (request, reply) => {
    if (auth && !(await sessionUser(request))) {
      return reply.redirect("/auth");
    }
    return reply.redirect("/health");
  });
  app.get("/auth", async (_request, reply) => reply.type("text/html; charset=utf-8").send(renderApplicationPage("auth")));
  app.get("/admin", async (request, reply) => {
    if (auth && !(await sessionUser(request))) {
      return reply.redirect("/auth");
    }
    return reply.type("text/html; charset=utf-8").send(renderApplicationPage("admin"));
  });
  app.get("/projects", async (request, reply) => {
    if (auth && !(await sessionUser(request))) {
      return reply.redirect("/auth");
    }
    return reply.type("text/html; charset=utf-8").send(renderApplicationPage("projects"));
  });
  app.get("/tasks", async (request, reply) => {
    if (auth && !(await sessionUser(request))) {
      return reply.redirect("/auth");
    }
    return reply.type("text/html; charset=utf-8").send(renderApplicationPage("tasks"));
  });
  app.get<{ Params: { taskId: string } }>("/tasks/:taskId", async (request, reply) => {
    if (auth && !(await sessionUser(request))) {
      return reply.redirect("/auth");
    }
    return reply.type("text/html; charset=utf-8").send(renderApplicationPage("tasks"));
  });
  app.get("/health", async (_request, reply) => {
    if (auth && !(await sessionUser(_request))) {
      return reply.redirect("/auth");
    }
    const snapshot = await readHealth();
    return reply.type("text/html; charset=utf-8").send(renderHealthPage(snapshot));
  });
  app.get("/api/health", async (request, reply) => {
    if (auth && !(await sessionUser(request))) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    return reply.send(await readHealth());
  });

  if (auth) {
    app.get("/api/auth/status", async (request, reply) => {
      return reply.send({ ...(auth.getBootstrapState()), authenticated: (await sessionUser(request)) !== undefined });
    });
    app.get("/api/auth/me", async (request, reply) => {
      const user = await requireUser(request, reply);
      return user ? reply.send({ user }) : reply;
    });
    app.post("/api/auth/bootstrap/options", async (request, reply) => {
      try {
        return reply.send({ ...(await auth.beginBootstrapRegistration(textBody(request, "token"))) });
      } catch (error) {
        return sendAuthError(reply, error);
      }
    });
    app.post("/api/auth/invitation/options", async (request, reply) => {
      try {
        return reply.send(await auth.beginInvitationRegistration(textBody(request, "token")));
      } catch (error) {
        return sendAuthError(reply, error);
      }
    });
    app.post("/api/auth/recovery/options", async (request, reply) => {
      try {
        return reply.send(await auth.beginRecoveryRegistration(textBody(request, "token")));
      } catch (error) {
        return sendAuthError(reply, error);
      }
    });
    const completeRegistration = async (kind: "bootstrap" | "invitation" | "recovery", request: { body: unknown }, reply: { code: (statusCode: number) => { send: (body: object) => unknown }; setCookie: (name: string, value: string, options: { httpOnly: boolean; sameSite: "lax"; secure: boolean; path: string; maxAge: number }) => unknown; send: (body: object) => unknown }): Promise<unknown> => {
      const body = requestBody(request);
      const input = { token: typeof body.token === "string" ? body.token : "", challengeId: typeof body.challengeId === "string" ? body.challengeId : "", response: body.response };
      try {
        const result = kind === "bootstrap"
          ? await auth.completeBootstrapRegistration(input)
          : kind === "recovery"
            ? await auth.completeRecoveryRegistration(input)
            : await auth.completeInvitationRegistration(input);
        setSessionCookie(reply, result.sessionToken);
        return reply.send({ user: result.user });
      } catch (error) {
        return sendAuthError(reply, error);
      }
    };
    app.post("/api/auth/bootstrap/verify", async (request, reply) => completeRegistration("bootstrap", request, reply));
    app.post("/api/auth/invitation/verify", async (request, reply) => completeRegistration("invitation", request, reply));
    app.post("/api/auth/recovery/verify", async (request, reply) => completeRegistration("recovery", request, reply));
    app.post("/api/auth/options", async (_request, reply) => {
      try {
        return reply.send(await auth.beginAuthentication());
      } catch (error) {
        return sendAuthError(reply, error);
      }
    });
    app.post("/api/auth/verify", async (request, reply) => {
      const body = requestBody(request);
      try {
        const result = await auth.completeAuthentication({ challengeId: typeof body.challengeId === "string" ? body.challengeId : "", response: body.response });
        setSessionCookie(reply, result.sessionToken);
        return reply.send({ user: result.user });
      } catch (error) {
        return sendAuthError(reply, error);
      }
    });
    app.post("/api/auth/sign-out", async (request, reply) => {
      auth.signOut(request.cookies.forge_session ?? "");
      reply.clearCookie("forge_session", { path: "/" });
      return reply.send({ signedOut: true });
    });
    app.get("/api/companies", async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return reply;
      try {
        return reply.send({ companies: auth.listVisibleCompanies(user.id) });
      } catch (error) {
        return sendAuthError(reply, error);
      }
    });
    app.get<{ Params: { companyId: string } }>("/api/companies/:companyId", async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return reply;
      try {
        return reply.send(auth.requireCompanyAccess(user.id, request.params.companyId));
      } catch (error) {
        return sendAuthError(reply, error);
      }
    });
    app.post("/api/admin/companies", async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return reply;
      try {
        return reply.code(201).send(auth.createCompany(user.id, textBody(request, "name")));
      } catch (error) {
        return sendAuthError(reply, error);
      }
    });
    app.post("/api/admin/invitations", async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return reply;
      try {
        return reply.code(201).send(auth.inviteUser(user.id, { displayName: textBody(request, "displayName") }));
      } catch (error) {
        return sendAuthError(reply, error);
      }
    });
    app.get("/api/admin/users", async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return reply;
      try {
        return reply.send({ users: auth.listUsers(user.id) });
      } catch (error) {
        return sendAuthError(reply, error);
      }
    });
    app.post<{ Params: { userId: string } }>("/api/admin/users/:userId/revoke", async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return reply;
      try {
        auth.revokeUser(user.id, request.params.userId);
        return reply.code(204).send();
      } catch (error) {
        return sendAuthError(reply, error);
      }
    });
    app.post<{ Params: { companyId: string } }>("/api/admin/companies/:companyId/members", async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return reply;
      try {
        auth.addMembership(user.id, textBody(request, "userId"), request.params.companyId);
        return reply.code(204).send();
      } catch (error) {
        return sendAuthError(reply, error);
      }
    });
    app.delete<{ Params: { companyId: string; userId: string } }>("/api/admin/companies/:companyId/members/:userId", async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return reply;
      try {
        auth.removeMembership(user.id, request.params.userId, request.params.companyId);
        return reply.code(204).send();
      } catch (error) {
        return sendAuthError(reply, error);
      }
    });
    app.get("/api/admin/audit", async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return reply;
      try {
        return reply.send({ events: auth.listAuditEvents(user.id) });
      } catch (error) {
        return sendAuthError(reply, error);
      }
    });
    if (projects) {
      const sendProjectError = (reply: { code: (statusCode: number) => { send: (body: object) => unknown } }, error: unknown): unknown => {
        if (error instanceof ProjectFailure) {
          return reply.code(error.statusCode).send({ error: error.publicMessage, findings: error.findings });
        }
        return reply.code(400).send({ error: "Project request failed" });
      };
      const projectInput = (request: { body: unknown }): ProjectInput => {
        const body = requestBody(request);
        const roleDefaults = body.roleDefaults && typeof body.roleDefaults === "object" && !Array.isArray(body.roleDefaults) ? body.roleDefaults as Record<string, unknown> : {};
        return {
          name: textBody(request, "name"),
          repositoryPath: textBody(request, "repositoryPath"),
          worktreeRoot: textBody(request, "worktreeRoot"),
          repository: textBody(request, "repository"),
          baseBranch: textBody(request, "baseBranch"),
          targetBranch: textBody(request, "targetBranch"),
          setupCommand: textBody(request, "setupCommand"),
          verificationCommand: textBody(request, "verificationCommand"),
          requiredChecks: Array.isArray(body.requiredChecks) ? body.requiredChecks.filter((value): value is string => typeof value === "string") : [],
          allowedProfileIds: Array.isArray(body.allowedProfileIds) ? body.allowedProfileIds.filter((value): value is string => typeof value === "string") : [],
          roleDefaults: Object.fromEntries(Object.entries(roleDefaults).filter(([role, value]) => ["lead", "developer", "reviewer"].includes(role) && typeof value === "string")) as Partial<Record<ProjectRole, string>>,
        };
      };
      app.get("/api/profiles", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        try { return reply.send({ profiles: projects.listProfiles(user.id) }); } catch (error) { return sendProjectError(reply, error); }
      });
      app.post("/api/admin/profiles", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        const body = requestBody(request);
        try {
          return reply.code(201).send(projects.createProfile(user.id, {
            name: textBody(request, "name"),
            model: textBody(request, "model"),
            reasoningLevel: textBody(request, "reasoningLevel") as "low" | "medium" | "high",
            servicePriority: textBody(request, "servicePriority") as "standard" | "priority",
            capacity: typeof body.capacity === "number" ? body.capacity : Number(body.capacity),
          }));
        } catch (error) { return sendProjectError(reply, error); }
      });
      app.get("/api/projects", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        try { return reply.send({ projects: projects.listProjects(user.id) }); } catch (error) { return sendProjectError(reply, error); }
      });
      app.get<{ Params: { companyId: string } }>("/api/companies/:companyId/projects", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        try { return reply.send({ projects: projects.listProjects(user.id, request.params.companyId) }); } catch (error) { return sendProjectError(reply, error); }
      });
      app.post<{ Params: { companyId: string } }>("/api/companies/:companyId/projects", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        try { return reply.code(201).send(await projects.createProject(user.id, request.params.companyId, projectInput(request))); } catch (error) { return sendProjectError(reply, error); }
      });
      app.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        try { return reply.send(projects.getProject(user.id, request.params.projectId)); } catch (error) { return sendProjectError(reply, error); }
      });
      app.patch<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        try { return reply.send(await projects.updateProject(user.id, request.params.projectId, projectInput(request))); } catch (error) { return sendProjectError(reply, error); }
      });
      for (const [path, action] of [["activate", "activateProject"], ["pause", "pauseProject"], ["archive", "archiveProject"]] as const) {
        app.post<{ Params: { projectId: string } }>(`/api/projects/:projectId/${path}`, async (request, reply) => {
          const user = await requireUser(request, reply);
          if (!user) return reply;
          try { return reply.send(await (action === "activateProject" ? projects.activateProject(user.id, request.params.projectId) : action === "pauseProject" ? projects.pauseProject(user.id, request.params.projectId) : projects.archiveProject(user.id, request.params.projectId))); } catch (error) { return sendProjectError(reply, error); }
        });
      }
      app.post<{ Params: { companyId: string; status: "active" | "paused" | "archived" } }>("/api/admin/companies/:companyId/status/:status", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        try { return reply.send(auth.setCompanyStatus(user.id, request.params.companyId, request.params.status)); } catch (error) { return sendAuthError(reply, error); }
      });
    }
    if (tasks) {
      const sendTaskError = (reply: { code: (statusCode: number) => { send: (body: object) => unknown } }, error: unknown): unknown => {
        if (error instanceof TaskFailure) return reply.code(error.statusCode).send({ error: error.publicMessage, findings: error.findings });
        if (error instanceof AuthFailure) return sendAuthError(reply, error);
        return reply.code(400).send({ error: "Task request failed" });
      };
      const taskInput = (request: { body: unknown }): TaskInput => {
        const body = requestBody(request);
        const roleProfiles = body.roleProfiles && typeof body.roleProfiles === "object" && !Array.isArray(body.roleProfiles) ? body.roleProfiles as Record<string, unknown> : {};
        const images = Array.isArray(body.images) ? body.images.flatMap((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return [];
          const image = value as Record<string, unknown>;
          return typeof image.filename === "string" && typeof image.mimeType === "string" && typeof image.base64 === "string" ? [{ filename: image.filename, mimeType: image.mimeType, base64: image.base64 }] : [];
        }) : [];
        return {
          projectId: textBody(request, "projectId"),
          title: textBody(request, "title"),
          description: textBody(request, "description"),
          idempotencyKey: textBody(request, "idempotencyKey"),
          images,
          ...(Object.fromEntries(Object.entries(roleProfiles).filter(([role, value]) => ["lead", "developer", "reviewer"].includes(role) && typeof value === "string")) as TaskInput["roleProfiles"]),
          supplementalReview: body.supplementalReview === true,
        };
      };
      app.get("/api/tasks", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        try { return reply.send({ tasks: tasks.listTasks(user.id) }); } catch (error) { return sendTaskError(reply, error); }
      });
      app.get<{ Params: { companyId: string } }>("/api/companies/:companyId/tasks", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        try { return reply.send({ tasks: tasks.listTasks(user.id, request.params.companyId) }); } catch (error) { return sendTaskError(reply, error); }
      });
      app.post<{ Params: { companyId: string } }>("/api/companies/:companyId/tasks", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        try {
          const result = await tasks.createTask(user.id, request.params.companyId, taskInput(request));
          return reply.code(result.created ? 201 : 200).send(result.task);
        } catch (error) { return sendTaskError(reply, error); }
      });
      app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        try { return reply.send(tasks.getTask(user.id, request.params.taskId)); } catch (error) { return sendTaskError(reply, error); }
      });
      app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/start-planning", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        const body = requestBody(request);
        try { return reply.send(await tasks.startPlanning(user.id, request.params.taskId, typeof body.expectedRevision === "number" ? body.expectedRevision : Number(body.expectedRevision))); } catch (error) { return sendTaskError(reply, error); }
      });
      app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/request-supplemental-review", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        const body = requestBody(request);
        try { return reply.send(await tasks.requestSupplementalReview(user.id, request.params.taskId, typeof body.expectedRevision === "number" ? body.expectedRevision : Number(body.expectedRevision))); } catch (error) { return sendTaskError(reply, error); }
      });
      app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/approve-plan", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        const body = requestBody(request);
        try { return reply.send(await tasks.approvePlan(user.id, request.params.taskId, typeof body.expectedRevision === "number" ? body.expectedRevision : Number(body.expectedRevision), typeof body.note === "string" ? body.note : undefined)); } catch (error) { return sendTaskError(reply, error); }
      });
      app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/reject-plan", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        const body = requestBody(request);
        try { return reply.send(await tasks.rejectPlan(user.id, request.params.taskId, typeof body.expectedRevision === "number" ? body.expectedRevision : Number(body.expectedRevision), typeof body.note === "string" ? body.note : undefined)); } catch (error) { return sendTaskError(reply, error); }
      });
      app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/start-development", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        const body = requestBody(request);
        try { return reply.send(await tasks.startDevelopment(user.id, request.params.taskId, typeof body.expectedRevision === "number" ? body.expectedRevision : Number(body.expectedRevision))); } catch (error) { return sendTaskError(reply, error); }
      });
      for (const [path, action] of [["review-delivery", "reviewDelivery"], ["repair-delivery", "repairDelivery"]] as const) {
        app.post<{ Params: { taskId: string } }>(`/api/tasks/:taskId/${path}`, async (request, reply) => {
          const user = await requireUser(request, reply);
          if (!user) return reply;
          const body = requestBody(request);
          try {
            const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : Number(body.expectedRevision);
            return reply.send(await (action === "reviewDelivery" ? tasks.reviewDelivery(user.id, request.params.taskId, expectedRevision) : tasks.repairDelivery(user.id, request.params.taskId, expectedRevision)));
          } catch (error) { return sendTaskError(reply, error); }
        });
      }
      app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/record-delivery-decision", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        const body = requestBody(request);
        try { return reply.send(await tasks.recordDeliveryDecision(user.id, request.params.taskId, typeof body.expectedRevision === "number" ? body.expectedRevision : Number(body.expectedRevision), typeof body.note === "string" ? body.note : undefined)); } catch (error) { return sendTaskError(reply, error); }
      });
      for (const [path, action] of [["retry-development", "retryDevelopment"], ["cancel-development", "cancelDevelopment"]] as const) {
        app.post<{ Params: { taskId: string } }>(`/api/tasks/:taskId/${path}`, async (request, reply) => {
          const user = await requireUser(request, reply);
          if (!user) return reply;
          const body = requestBody(request);
          try { return reply.send(await (action === "retryDevelopment" ? tasks.retryDevelopment(user.id, request.params.taskId, typeof body.expectedRevision === "number" ? body.expectedRevision : Number(body.expectedRevision)) : tasks.cancelDevelopment(user.id, request.params.taskId, typeof body.expectedRevision === "number" ? body.expectedRevision : Number(body.expectedRevision)))); } catch (error) { return sendTaskError(reply, error); }
        });
      }
      app.get<{ Params: { taskId: string; artifactId: string } }>("/api/tasks/:taskId/images/:artifactId", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        try {
          const image = await tasks.getTaskImage(user.id, request.params.taskId, request.params.artifactId);
          return reply.header("Cache-Control", "private, no-store").type(image.artifact.mimeType).send(image.bytes);
        } catch (error) { return sendTaskError(reply, error); }
      });
      app.get("/api/tasks/events", async (request, reply) => {
        const user = await requireUser(request, reply);
        if (!user) return reply;
        reply.hijack();
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store", Connection: "keep-alive" });
        const send = (event: TaskEvent): void => { reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); };
        reply.raw.write("event: ready\ndata: {}\n\n");
        const unsubscribe = tasks.subscribe(user.id, send);
        request.raw.on("close", unsubscribe);
        return reply;
      });
    }
  }
  app.get("/assets/forge-ui.js", async (_request, reply) => {
    try {
      return reply.type("text/javascript; charset=utf-8").send(await readFrontendAsset("forge-ui.js"));
    } catch {
      return reply.code(404).type("text/plain; charset=utf-8").send("Forge UI asset is not built");
    }
  });
  app.get("/assets/forge-ui.css", async (_request, reply) => {
    try {
      return reply.type("text/css; charset=utf-8").send(await readFrontendAsset("forge-ui.css"));
    } catch {
      return reply.code(404).type("text/plain; charset=utf-8").send("Forge UI asset is not built");
    }
  });

  return app;
}
