import { isResponseSerializationError } from "@fastify/type-provider-zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { AuthFailure } from "../identity/auth.js";
import { ProjectFailure } from "../projects/projects.js";
import { TaskFailure } from "../tasks/tasks.js";
import { redact } from "../platform/logging.js";
import { ExternalAgentFailure } from "../identity/external-agents.js";
import { ArtifactFailure } from "../platform/artifacts.js";
import { TaskSourceFailure } from "../tasks/sources.js";
import { isAgentApiRuntimeRequest } from "./agent-api-runtime.js";

interface ValidationIssue {
  instancePath?: string;
  keyword?: string;
  message?: string;
  params?: { missingProperty?: string };
}

function validationFindings(error: { validation?: ValidationIssue[] }): Array<{ code: string; field: string; message: string }> {
  return (error.validation ?? []).flatMap((issue) => {
    const field = issue.instancePath?.replace(/^\//, ".").replaceAll("/", ".") || issue.params?.missingProperty || "request";
    const message = issue.message === "must be integer" ? "Must be an integer" : issue.message === "must be string" ? "Must be a string" : issue.message === "must be object" ? "Must be an object" : issue.message === "must be array" ? "Must be an array" : "Request value is invalid";
    return [{ code: `invalid-${issue.keyword ?? "request"}`, field, message }];
  });
}

function isBodyParserFailure(error: unknown): error is { code: string; statusCode: number } {
  if (!error || typeof error !== "object" || !("code" in error) || !("statusCode" in error)) return false;
  const candidate = error as { code?: unknown; statusCode?: unknown };
  return typeof candidate.code === "string" && candidate.code.startsWith("FST_ERR_CTP_")
    && typeof candidate.statusCode === "number" && candidate.statusCode >= 400 && candidate.statusCode < 500;
}

// Fixed messages only: a raw parser message can contain a fragment of the request body.
function bodyParserMessage(code: string): string {
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") return "Request body is too large";
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return "Unsupported media type";
  return "Invalid request";
}

 function isValidationError(error: unknown): error is { validation?: ValidationIssue[] } {
   return Boolean(error && typeof error === "object" && "validation" in error);
 }

function agentApiTaskFailureCode(error: TaskFailure): "not_found" | "idempotency_conflict" | "command_in_progress" | "revision_stale" | "illegal_command" | "request_invalid" | "delivery_policy_rejected" | "project_not_found" | "dependency_not_found" | "root_profile_not_found" | "root_profile_not_permitted" | "worker_profile_not_found" | "worker_profile_not_permitted" | "advisor_profile_not_found" | "advisor_profile_not_permitted" | "source_issue_rejected" | "source_pull_request_rejected" | "source_branch_rejected" | "workflow_not_found" | "workflow_not_permitted" | "template_not_found" | "template_not_permitted" | "task_unavailable" {
  if (error.statusCode === 404) return "not_found";
  if (error.code === "delivery_policy_rejected") return "delivery_policy_rejected";
  if (error.code === "project_not_found") return "project_not_found";
  if (error.code === "dependency_not_found") return "dependency_not_found";
  if (error.code === "root_profile_not_found") return "root_profile_not_found";
  if (error.code === "root_profile_not_permitted") return "root_profile_not_permitted";
  if (error.code === "worker_profile_not_found") return "worker_profile_not_found";
  if (error.code === "worker_profile_not_permitted") return "worker_profile_not_permitted";
  if (error.code === "advisor_profile_not_found") return "advisor_profile_not_found";
  if (error.code === "advisor_profile_not_permitted") return "advisor_profile_not_permitted";
  if (error.code === "source_issue_rejected") return "source_issue_rejected";
  if (error.code === "source_pull_request_rejected") return "source_pull_request_rejected";
  if (error.code === "source_branch_rejected") return "source_branch_rejected";
  if (error.code === "workflow_not_found") return "workflow_not_found";
  if (error.code === "workflow_not_permitted") return "workflow_not_permitted";
  if (error.code === "template_not_found") return "template_not_found";
  if (error.code === "template_not_permitted") return "template_not_permitted";
  if (error.publicMessage === "This idempotency key belongs to a different request") return "idempotency_conflict";
  if (error.code === "revision_stale") return "revision_stale";
  if (error.code === "command_in_progress") return "command_in_progress";
  if (error.code === "illegal_command") return "illegal_command";
  if (error.code === "request_invalid") return "request_invalid";
  return "task_unavailable";
}

function sendDomainFailure(request: FastifyRequest, reply: FastifyReply, error: AuthFailure | ProjectFailure | TaskFailure | ExternalAgentFailure): void {
  const runtime = isAgentApiRuntimeRequest(request);
  const body = error instanceof ExternalAgentFailure
    ? { error: error.publicMessage, ...(error.code !== "auth_failure" ? { code: error.code } : {}) }
    : error instanceof AuthFailure && runtime
      ? { error: error.publicMessage, code: "not_found" }
      : error instanceof AuthFailure
        ? { error: error.publicMessage, ...(error.code !== "auth_failure" ? { code: error.code } : {}) }
    : error instanceof TaskFailure && runtime
      ? { error: error.publicMessage, code: agentApiTaskFailureCode(error), ...error.details }
    : error instanceof ProjectFailure && runtime
      ? { error: error.publicMessage, code: error.statusCode === 404 ? "not_found" : "task_unavailable", findings: error.findings }
    : { error: error.publicMessage, ...(error instanceof TaskFailure && error.code !== "task_failure" ? { code: error.code } : {}), ...(error instanceof ProjectFailure ? { findings: error.findings } : {}) };
  reply.code(error.statusCode).send(body);
}

export function installHttpErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    const runtime = isAgentApiRuntimeRequest(request);
    if (isValidationError(error)) {
      const findings = validationFindings(error);
      request.log.warn({ requestId: request.id, statusCode: 400, findings: redact(findings) }, "Request rejected");
      reply.code(400).send({ error: "Invalid request", ...(runtime ? { code: "request_invalid" } : {}), ...(findings.length > 0 ? { findings } : {}) });
      return;
    }
    if (error instanceof AuthFailure || error instanceof ProjectFailure || error instanceof TaskFailure || error instanceof ExternalAgentFailure) {
      const fields = { requestId: request.id, method: request.method, url: request.url, statusCode: error.statusCode, error: redact(error.publicMessage), ...(error instanceof ProjectFailure ? { findings: redact(error.findings) } : {}) };
      if (error.statusCode >= 500) request.log.error({ ...fields, err: error }, "Request failed"); else request.log.warn(fields, "Request rejected");
      sendDomainFailure(request, reply, error);
      return;
    }
    if (error instanceof ArtifactFailure || error instanceof TaskSourceFailure) {
      if (runtime) reply.code(error instanceof TaskSourceFailure ? error.statusCode : 422).send({ error: error.message, code: "task_unavailable" });
      else reply.code(error instanceof TaskSourceFailure ? error.statusCode : 422).send({ error: error.message, code: error.code });
      return;
    }
    if (isBodyParserFailure(error)) {
      request.log.warn({ requestId: request.id, method: request.method, url: request.url, code: error.code, statusCode: error.statusCode }, "Request rejected");
      if (runtime) {
        const code = error.code === "FST_ERR_CTP_BODY_TOO_LARGE" ? "payload_too_large" : error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ? "unsupported_media_type" : "request_invalid";
        reply.code(error.statusCode).send({ error: bodyParserMessage(error.code), code });
      } else if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") reply.code(error.statusCode).send({ error: "Request is too large", findings: [{ code: "request-too-large", field: "images", message: "Attach fewer or smaller images and submit again" }] });
      else reply.code(error.statusCode).send({ error: bodyParserMessage(error.code) });
      return;
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ requestId: request.id, method: error.method, url: error.url, issues: error.cause.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message })) }, "Response doesn't match the schema");
      reply.code(500).send(runtime ? { error: "Internal server error", code: "internal_error" } : { error: "Internal server error" });
      return;
    }
    request.log.error({ requestId: request.id, method: request.method, url: request.url, error: redact(error instanceof Error ? error.message : String(error)) }, "Unhandled request error");
    reply.code(500).send(runtime ? { error: "Internal server error", code: "internal_error" } : { error: "Internal server error" });
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith("/api/")) {
      reply.code(404).send({ error: "Not found" });
      return;
    }
    reply.code(404).type("text/plain; charset=utf-8").send("Not found");
  });
}
