import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import type { AuthService } from "../../identity/auth.js";
import type { ProjectService } from "../../projects/projects.js";
import type { SuplexConfig } from "../../platform/config.js";
import type { HealthSnapshot } from "../../platform/health.js";
import { renderApplicationPage, renderHealthPage } from "../../platform/ui.js";
import { sessionUser } from "../session.js";

export interface PageRoutesOptions {
  auth?: AuthService;
  projects?: Pick<ProjectService, "listProjects">;
  config?: SuplexConfig;
  readHealth: () => Promise<HealthSnapshot>;
  transformHtml?: (url: string, html: string) => Promise<string>;
}

const pages: FastifyPluginAsync<PageRoutesOptions> = async (app, options) => {
  const { auth } = options;
  const assetMode = options.transformHtml ? "development" : "built";
  const sendHtml = async (request: FastifyRequest, reply: FastifyReply, html: string): Promise<FastifyReply> => {
    const body = options.transformHtml ? await options.transformHtml(request.url, html) : html;
    if (options.transformHtml) reply.header("Cache-Control", "no-store");
    return reply.type("text/html; charset=utf-8").send(body);
  };
  const requirePageSession = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (auth && !(await sessionUser(auth, request, reply, options.config))) {
      await reply.redirect("/auth");
      return false;
    }
    return true;
  };

  app.get("/", async (request, reply) => {
    const user = auth ? await sessionUser(auth, request, reply, options.config) : undefined;
    if (auth && !user) return reply.redirect("/auth");
    if (user && options.projects && options.projects.listProjects(user.id).length === 0) return reply.redirect("/onboarding");
    return reply.redirect("/tasks");
  });
  app.get("/auth", async (request, reply) => sendHtml(request, reply, renderApplicationPage("auth", assetMode)));
  app.get("/oauth/consent", async (request, reply) => {
    const requestId = (request.query as { request?: unknown }).request;
    if (typeof requestId !== "string" || !/^oauth_request_[a-f0-9]{32}$/.test(requestId)) return reply.code(400).type("text/plain; charset=utf-8").send("Invalid authorization request");
    if (auth && !(await sessionUser(auth, request, reply, options.config))) return reply.redirect(`/auth?returnTo=${encodeURIComponent(`/oauth/consent?request=${requestId}`)}`);
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    return sendHtml(request, reply, renderApplicationPage("oauth-consent", assetMode));
  });
  app.get("/admin", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("admin", assetMode));
  });
  app.get("/admin/prompts", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("admin", assetMode));
  });
  app.get("/admin/profiles", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("admin", assetMode));
  });
  app.get("/admin/workflows", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("admin", assetMode));
  });
  app.get("/admin/triggers", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("admin", assetMode));
  });
  app.get("/admin/agents", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("admin", assetMode));
  });
  app.get("/admin/models", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("admin", assetMode));
  });
  app.get("/admin/providers", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("admin", assetMode));
  });
  app.get("/admin/onboarding", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("onboarding", assetMode));
  });
  app.get("/admin/environment", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("admin", assetMode));
  });
  app.get("/admin/backups", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("admin", assetMode));
  });
  app.get("/admin/companies", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("admin", assetMode));
  });
  app.get("/admin/invitations", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("admin", assetMode));
  });
  app.get("/admin/passkeys", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("admin", assetMode));
  });
  app.get<{ Params: { companyId: string } }>("/companies/:companyId/settings", async (request, reply) => {
    const user = auth ? await sessionUser(auth, request, reply, options.config) : undefined;
    if (auth && !user) return reply.redirect("/auth");
    if (auth && (!user || user.role !== "admin")) return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
    if (auth && user) {
      try {
        auth.requireCompanyAccess(user.id, request.params.companyId);
      } catch {
        return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
      }
    }
    return sendHtml(request, reply, renderApplicationPage("company-settings", assetMode));
  });
  app.get("/profile", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("profile", assetMode));
  });
  app.get("/templates", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("project-templates", assetMode));
  });
  app.get<{ Params: { projectId: string } }>("/projects/:projectId/prompts", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("project-prompts", assetMode));
  });
  app.get<{ Params: { projectId: string } }>("/projects/:projectId/templates", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("project-templates", assetMode));
  });
  app.get<{ Params: { projectId: string } }>("/projects/:projectId", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("projects", assetMode));
  });
  app.get("/projects", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("projects", assetMode));
  });
  app.get("/tasks", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("tasks", assetMode));
  });
  app.get("/tasks/:taskId", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("tasks", assetMode));
  });
  app.get("/board", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("board", assetMode));
  });
  app.get("/board/:taskId", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("board", assetMode));
  });
  app.get("/timeline", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("timeline", assetMode));
  });
  app.get("/analytics", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("analytics", assetMode));
  });
  app.get("/health", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    reply.header("Cache-Control", "no-store");
    return sendHtml(request, reply, renderHealthPage(await options.readHealth(), assetMode));
  });
  app.get("/setup", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("setup", assetMode));
  });
  app.get("/onboarding", async (request, reply) => {
    if (!(await requirePageSession(request, reply))) return reply;
    return sendHtml(request, reply, renderApplicationPage("onboarding", assetMode));
  });
};

export default pages;
