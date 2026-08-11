import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import type { AuthService } from "../../auth.js";
import type { HealthSnapshot } from "../../health.js";
import { renderApplicationPage, renderHealthPage } from "../../ui.js";
import { sessionUser } from "../session.js";

export interface PageRoutesOptions {
  auth?: AuthService;
  readHealth: () => Promise<HealthSnapshot>;
}

const pages: FastifyPluginAsync<PageRoutesOptions> = async (app, options) => {
  const { auth } = options;
  const requirePageSession = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (auth && !(await sessionUser(auth, request))) {
      await reply.redirect("/auth");
      return false;
    }
    return true;
  };

  app.get("/", async (request, reply) => {
    if (auth && !(await sessionUser(auth, request))) return reply.redirect("/auth");
    return reply.redirect("/health");
  });
  app.get("/auth", async (_request, reply) => reply.type("text/html; charset=utf-8").send(renderApplicationPage("auth")));
  app.get("/admin", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return reply.type("text/html; charset=utf-8").send(renderApplicationPage("admin"));
  });
  app.get("/admin/profiles", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return reply.type("text/html; charset=utf-8").send(renderApplicationPage("admin"));
  });
  app.get<{ Params: { companyId: string } }>("/companies/:companyId/settings", async (request, reply) => {
    const user = auth ? await sessionUser(auth, request) : undefined;
    if (auth && !user) return reply.redirect("/auth");
    if (auth && (!user || user.role !== "admin")) return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
    if (auth && user) {
      try {
        auth.requireCompanyAccess(user.id, request.params.companyId);
      } catch {
        return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
      }
    }
    return reply.type("text/html; charset=utf-8").send(renderApplicationPage("company-settings"));
  });
  app.get("/projects", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return reply.type("text/html; charset=utf-8").send(renderApplicationPage("projects"));
  });
  app.get("/tasks", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return reply.type("text/html; charset=utf-8").send(renderApplicationPage("tasks"));
  });
  app.get("/tasks/:taskId", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return reply.type("text/html; charset=utf-8").send(renderApplicationPage("tasks"));
  });
  app.get("/attention", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return reply.type("text/html; charset=utf-8").send(renderApplicationPage("attention"));
  });
  app.get("/health", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return reply.type("text/html; charset=utf-8").send(renderHealthPage(await options.readHealth()));
  });
};

export default pages;
