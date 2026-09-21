import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../identity/auth-identifiers.js";
import type { AuthService } from "../../identity/auth.js";
import { OAuthFailure, type OAuthService, oauthFailureFromExternal } from "../../identity/oauth.js";
import type { ForgeConfig } from "../../platform/config.js";
import type { ProjectService } from "../../projects/projects.js";
import { OAuthClientRegistrationSchema, OAuthConsentApprovalSchema, OAuthConsentDecisionResponseSchema, OAuthConsentParamsSchema, OAuthConsentResponseSchema } from "../contracts/oauth.js";
import { sessionUser } from "../session.js";

interface OAuthRoutesOptions {
  oauth: OAuthService;
  auth: AuthService;
  projects: ProjectService;
  config: ForgeConfig;
}

const AuthorizeQuerySchema = z.object({
  client_id: z.string(), redirect_uri: z.string(), response_type: z.string(), state: z.string().optional(), scope: z.string().optional(), resource: z.string(), code_challenge: z.string(), code_challenge_method: z.string(),
});
const TokenFormSchema = z.discriminatedUnion("grant_type", [
  z.object({ grant_type: z.literal("authorization_code"), code: z.string(), client_id: z.string(), redirect_uri: z.string(), resource: z.string(), code_verifier: z.string() }),
  z.object({ grant_type: z.literal("refresh_token"), refresh_token: z.string(), client_id: z.string(), resource: z.string(), scope: z.string().optional() }),
]);
const RevokeFormSchema = z.object({ token: z.string(), client_id: z.string().optional(), token_type_hint: z.string().optional() });

function parseForm<T>(raw: unknown, schema: z.ZodType<T>): T {
  if (typeof raw !== "string") throw new OAuthFailure("invalid_request", "Form body is invalid", 400);
  const params = new URLSearchParams(raw);
  const values: Record<string, string> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    if (all.length !== 1) throw new OAuthFailure("invalid_request", "Form body contains duplicate fields", 400);
    values[key] = all[0]!;
  }
  const parsed = schema.safeParse(values);
  if (!parsed.success) throw new OAuthFailure("invalid_request", "Form body is invalid", 400);
  return parsed.data;
}

function challenge(oauth: OAuthService): string {
  return `Bearer resource_metadata="${oauth.issuer}/.well-known/oauth-protected-resource/mcp", scope="forge:mcp"`;
}

function oauthError(reply: FastifyReply, error: unknown, oauth: OAuthService): FastifyReply {
  const failure = oauthFailureFromExternal(error);
  if (failure.redirectUri) {
    const target = new URL(failure.redirectUri);
    target.searchParams.set("error", failure.error);
    target.searchParams.set("error_description", failure.publicMessage);
    target.searchParams.set("iss", oauth.issuer);
    if (failure.state !== undefined) target.searchParams.set("state", failure.state);
    return reply.redirect(target.toString());
  }
  if (failure.statusCode === 401) reply.header("WWW-Authenticate", challenge(oauth));
  return reply.header("Cache-Control", "no-store").code(failure.statusCode).send({ error: failure.error, error_description: failure.publicMessage });
}

function requireCsrf(request: FastifyRequest): void {
  const header = Array.isArray(request.headers[CSRF_HEADER_NAME]) ? request.headers[CSRF_HEADER_NAME][0] : request.headers[CSRF_HEADER_NAME];
  const cookie = request.cookies[CSRF_COOKIE_NAME];
  if (typeof header !== "string" || header.length < 32 || header !== cookie) throw new OAuthFailure("access_denied", "Request origin is invalid", 403);
}

const oauthRoutes: FastifyPluginAsync<OAuthRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { oauth, auth, projects, config } = options;
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_request, body, done) => done(null, body));
  const registrations = new Map<string, number[]>();

  typed.post("/oauth/register", { config: { oauthProtocol: true } }, async (request, reply) => {
    try {
      const cutoff = Date.now() - 60 * 60_000;
      for (const [source, times] of registrations) {
        const current = times.filter((time) => time >= cutoff);
        if (current.length === 0) registrations.delete(source); else registrations.set(source, current);
      }
      const recent = (registrations.get(request.ip) ?? []).filter((time) => time >= cutoff);
      if (recent.length >= 20) throw new OAuthFailure("temporarily_unavailable", "Client registration limit reached", 429);
      if (!registrations.has(request.ip) && registrations.size >= 1_000) throw new OAuthFailure("temporarily_unavailable", "Client registration limit reached", 429);
      registrations.set(request.ip, [...recent, Date.now()]);
      const parsed = OAuthClientRegistrationSchema.safeParse(request.body);
      if (!parsed.success) throw new OAuthFailure("invalid_client_metadata", "Client metadata is invalid", 400);
      const body = parsed.data;
      return reply.header("Cache-Control", "no-store").code(201).send(oauth.registerClient({ client_name: body.client_name, redirect_uris: body.redirect_uris, ...(body.grant_types === undefined ? {} : { grant_types: body.grant_types }), ...(body.response_types === undefined ? {} : { response_types: body.response_types }), ...(body.token_endpoint_auth_method === undefined ? {} : { token_endpoint_auth_method: body.token_endpoint_auth_method }) }));
    }
    catch (error) { return oauthError(reply, error, oauth); }
  });

  typed.get("/oauth/authorize", async (request, reply) => {
    try {
      const parsed = AuthorizeQuerySchema.safeParse(request.query);
      if (!parsed.success) throw new OAuthFailure("invalid_request", "Authorization request is invalid", 400);
      const query = parsed.data;
      const { requestId } = oauth.beginAuthorization({
        clientId: query.client_id ?? "",
        redirectUri: query.redirect_uri ?? "",
        responseType: query.response_type ?? "",
        ...(query.state === undefined ? {} : { state: query.state }),
        ...(query.scope === undefined ? {} : { scope: query.scope }),
        resource: query.resource ?? "",
        codeChallenge: query.code_challenge ?? "",
        codeChallengeMethod: query.code_challenge_method ?? "",
      });
      const consentPath = `/oauth/consent?request=${encodeURIComponent(requestId)}`;
      const user = await sessionUser(auth, request, reply, config);
      return reply.redirect(user ? consentPath : `/auth?returnTo=${encodeURIComponent(consentPath)}`);
    } catch (error) { return oauthError(reply, error, oauth); }
  });

  typed.get("/api/oauth/consent/:requestId", { schema: { params: OAuthConsentParamsSchema, response: { 200: OAuthConsentResponseSchema, 401: z.object({ error: z.string() }) } } }, async (request, reply) => {
    const user = await sessionUser(auth, request, reply, config);
    if (!user) return reply.code(401).send({ error: "Authentication is necessary" });
    try {
      const consent = oauth.readConsent(user.id, request.params.requestId);
      const visibleProjects = projects.listProjects(user.id).map(({ id, name, companyId }) => ({ id, name, companyId }));
      return reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer").send({ ...consent, projects: visibleProjects });
    } catch (error) { return oauthError(reply, error, oauth); }
  });

  typed.post("/api/oauth/consent/:requestId/approve", { schema: { params: OAuthConsentParamsSchema, body: OAuthConsentApprovalSchema, response: { 200: OAuthConsentDecisionResponseSchema } } }, async (request, reply) => {
    try {
      requireCsrf(request);
      const user = await sessionUser(auth, request, reply, config);
      if (!user) throw new OAuthFailure("access_denied", "Authentication is necessary", 401);
      return reply.header("Cache-Control", "no-store").send({ redirectTo: oauth.approve({ userId: user.id, requestId: request.params.requestId, companyId: request.body.companyId, projectIds: request.body.projectIds }) });
    } catch (error) { return oauthError(reply, error, oauth); }
  });

  typed.post("/api/oauth/consent/:requestId/deny", { schema: { params: OAuthConsentParamsSchema, response: { 200: OAuthConsentDecisionResponseSchema } } }, async (request, reply) => {
    try {
      requireCsrf(request);
      const user = await sessionUser(auth, request, reply, config);
      if (!user) throw new OAuthFailure("access_denied", "Authentication is necessary", 401);
      return reply.header("Cache-Control", "no-store").send({ redirectTo: oauth.deny(user.id, request.params.requestId) });
    } catch (error) { return oauthError(reply, error, oauth); }
  });

  typed.post("/oauth/token", { config: { oauthProtocol: true } }, async (request, reply) => {
    try {
      const body = parseForm(request.body, TokenFormSchema);
      const result = body.grant_type === "authorization_code"
        ? oauth.exchangeCode({ code: body.code ?? "", clientId: body.client_id ?? "", redirectUri: body.redirect_uri ?? "", resource: body.resource ?? "", verifier: body.code_verifier ?? "" })
        : body.grant_type === "refresh_token"
          ? oauth.refresh({ refreshToken: body.refresh_token ?? "", clientId: body.client_id ?? "", resource: body.resource ?? "", ...(body.scope === undefined ? {} : { scope: body.scope }) })
          : (() => { throw new OAuthFailure("unsupported_grant_type", "Grant type is not supported", 400); })();
      return reply.header("Cache-Control", "no-store").header("Pragma", "no-cache").send(result);
    } catch (error) { return oauthError(reply, error, oauth); }
  });

  typed.post("/oauth/revoke", { config: { oauthProtocol: true } }, async (request, reply) => {
    try {
      const body = parseForm(request.body, RevokeFormSchema);
      oauth.revoke(body.token, body.client_id);
      return reply.header("Cache-Control", "no-store").code(200).send();
    } catch (error) { return oauthError(reply, error, oauth); }
  });
};

export default oauthRoutes;
export { challenge as oauthBearerChallenge };
