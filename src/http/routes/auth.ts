import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";

import type { AuthService } from "../../auth.js";
import type { ForgeConfig } from "../../config.js";
import { LEGACY_SESSION_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../auth-identifiers.js";
import type { FastifyReply } from "fastify";
import { AuthEnvelopeSchema, AuthOptionsResponseSchema, AuthStatusResponseSchema, ErrorResponseSchema, SignOutResponseSchema, TokenBodySchema, RegistrationVerificationBodySchema, AuthenticationVerificationBodySchema } from "../contracts/common.js";
import { ProfileBodySchema } from "../contracts/auth.js";
import { authenticatedUser, clearSessionCookies, setSessionCookie, sessionUser } from "../session.js";

export interface AuthRoutesOptions {
  auth: AuthService;
  config: ForgeConfig;
}

export const authMe: FastifyPluginAsync<Pick<AuthRoutesOptions, "auth">> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get("/me", { schema: { response: { 200: AuthEnvelopeSchema } } }, async (request, reply) => reply.send({ user: authenticatedUser(request) }));
  typed.patch("/me", { schema: { body: ProfileBodySchema, response: { 200: AuthEnvelopeSchema } } }, async (request, reply) => reply.send({ user: options.auth.updateProfile(authenticatedUser(request).id, request.body) }));
};

const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { auth, config } = options;

  typed.get("/status", { schema: { response: { 200: AuthStatusResponseSchema } } }, async (request, reply) => reply.send({ ...auth.getBootstrapState(), authenticated: (await sessionUser(auth, request, reply, config)) !== undefined }));

  typed.post("/bootstrap/options", { schema: { body: TokenBodySchema, response: { 200: AuthOptionsResponseSchema } } }, async (request, reply) => reply.send({ ...(await auth.beginBootstrapRegistration(request.body.token)) }));
  typed.post("/invitation/options", { schema: { body: TokenBodySchema, response: { 200: AuthOptionsResponseSchema } } }, async (request, reply) => reply.send(await auth.beginInvitationRegistration(request.body.token)));
  typed.post("/recovery/options", { schema: { body: TokenBodySchema, response: { 200: AuthOptionsResponseSchema } } }, async (request, reply) => reply.send(await auth.beginRecoveryRegistration(request.body.token)));

  const completeRegistration = async (kind: "bootstrap" | "invitation" | "recovery", body: { token: string; challengeId: string; response: unknown }, reply: FastifyReply): Promise<void> => {
    const result = kind === "bootstrap"
      ? await auth.completeBootstrapRegistration(body)
      : kind === "recovery"
        ? await auth.completeRecoveryRegistration(body)
        : await auth.completeInvitationRegistration(body);
    setSessionCookie(config, reply, result.sessionToken);
    reply.send({ user: result.user });
  };
  typed.post("/bootstrap/verify", { schema: { body: RegistrationVerificationBodySchema, response: { 200: AuthEnvelopeSchema } } }, async (request, reply) => completeRegistration("bootstrap", request.body, reply));
  typed.post("/invitation/verify", { schema: { body: RegistrationVerificationBodySchema, response: { 200: AuthEnvelopeSchema } } }, async (request, reply) => completeRegistration("invitation", request.body, reply));
  typed.post("/recovery/verify", { schema: { body: RegistrationVerificationBodySchema, response: { 200: AuthEnvelopeSchema } } }, async (request, reply) => completeRegistration("recovery", request.body, reply));

  typed.post("/options", { schema: { response: { 200: AuthOptionsResponseSchema } } }, async (_request, reply) => reply.send(await auth.beginAuthentication()));
  typed.post("/verify", { schema: { body: AuthenticationVerificationBodySchema, response: { 200: AuthEnvelopeSchema } } }, async (request, reply) => {
    const result = await auth.completeAuthentication(request.body);
    setSessionCookie(config, reply, result.sessionToken);
    return reply.send({ user: result.user });
  });
  typed.post("/sign-out", { schema: { response: { 200: SignOutResponseSchema, 401: ErrorResponseSchema } } }, async (request, reply) => {
    if (!(await sessionUser(auth, request))) return reply.code(401).send({ error: "Authentication required" });
    auth.signOut(request.cookies[SESSION_COOKIE_NAME] ?? request.cookies[LEGACY_SESSION_COOKIE_NAME] ?? "");
    clearSessionCookies(reply);
    return reply.send({ signedOut: true });
  });
};

export default authRoutes;
