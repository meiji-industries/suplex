import { z } from "zod";

export const OAuthClientRegistrationSchema = z.object({
  client_name: z.string(),
  redirect_uris: z.array(z.string()),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
}).passthrough();

export const OAuthConsentParamsSchema = z.object({ requestId: z.string().min(1).max(128) });

export const OAuthConsentResponseSchema = z.object({
  requestId: z.string(),
  clientName: z.string(),
  redirectUri: z.string(),
  redirectOrigin: z.string(),
  scope: z.string(),
  companies: z.array(z.object({ id: z.string(), name: z.string() })),
  projects: z.array(z.object({ id: z.string(), name: z.string(), companyId: z.string() })),
});

export const OAuthConsentApprovalSchema = z.object({
  companyId: z.string().min(1).max(128),
  projectIds: z.array(z.string().min(1).max(128)).min(1).max(100),
}).strict();

export const OAuthConsentDecisionResponseSchema = z.object({ redirectTo: z.string() });
