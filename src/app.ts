import { readFile } from "node:fs/promises";

import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";

import { AuthFailure, AuthService, type AuthUser } from "./auth.js";
import type { ForgeConfig } from "./config.js";
import { inspectHostHealth, type HealthSnapshot, type HostHealthDependencies } from "./health.js";
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
}

export function createApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(cookie);
  const getHealth = dependencies.getHealth ?? (() => inspectHostHealth(dependencies.config, dependencies.health));
  const readHealth = async (): Promise<HealthSnapshot> => HealthSnapshotSchema.parse(await getHealth());
  const auth = dependencies.auth;
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
