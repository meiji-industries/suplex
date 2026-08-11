import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";

import { AuthService } from "../../auth.js";
import type { ForgeConfig } from "../../config.js";
import type { FastifyReply } from "fastify";
import { AuthEnvelopeSchema, AuthOptionsResponseSchema, AuthStatusResponseSchema, SignOutResponseSchema, TokenBodySchema, RegistrationVerificationBodySchema, AuthenticationVerificationBodySchema } from "../contracts/common.js";
import { authenticatedUser, setSessionCookie } from "../session.js";

export interface AuthRoutesOptions {
  auth: AuthService;
  config: ForgeConfig;
}

export const authMe: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get("/me", { schema: { response: { 200: AuthEnvelopeSchema } } }, async (request, reply) => reply.send({ user: authenticatedUser(request) }));
};

const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { auth, config } = options;

  typed.get("/status", { schema: { response: { 200: AuthStatusResponseSchema } } }, async (request, reply) => reply.send({ ...auth.getBootstrapState(), authenticated: (await auth.getUserBySession(request.cookies.forge_session ?? "")) !== undefined }));

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
  typed.post("/sign-out", { schema: { response: { 200: SignOutResponseSchema } } }, async (request, reply) => {
    auth.signOut(request.cookies.forge_session ?? "");
    reply.clearCookie("forge_session", { path: "/" });
    return reply.send({ signedOut: true });
  });
};

export default authRoutes;
