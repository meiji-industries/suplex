import { isResponseSerializationError } from "@fastify/type-provider-zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { AuthFailure } from "../auth.js";
import { ProjectFailure } from "../projects.js";
import { TaskFailure } from "../tasks.js";
import { redact } from "../logging.js";
import { HermesAgentFailure } from "../hermes-agents.js";

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

function isValidationError(error: unknown): error is { validation?: ValidationIssue[] } {
  return Boolean(error && typeof error === "object" && "validation" in error);
}

function conflictSnapshot(task: TaskFailure["current"]): unknown {
  if (!task) return undefined;
  return {
    id: task.id,
    revision: task.revision,
    phase: task.phase,
    owner: task.owner,
    allowedCommands: task.allowedCommands,
    pendingAction: task.pendingAction,
    projection: task.projection,
  };
}

function sendDomainFailure(reply: FastifyReply, error: AuthFailure | ProjectFailure | TaskFailure | HermesAgentFailure): void {
  const body = error instanceof AuthFailure || error instanceof HermesAgentFailure
    ? { error: error.publicMessage, ...(error.code !== "auth_failure" ? { code: error.code } : {}) }
    : { error: error.publicMessage, findings: error.findings, ...(error instanceof TaskFailure && error.current ? { current: conflictSnapshot(error.current) } : {}), ...(error instanceof TaskFailure && error.ownerTaskId ? { ownerTaskId: error.ownerTaskId } : {}) };
  reply.code(error.statusCode).send(body);
}

export function installHttpErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (isValidationError(error)) {
      const findings = validationFindings(error);
      request.log.warn({ requestId: request.id, statusCode: 400, findings: redact(findings) }, "Request rejected");
      reply.code(400).send({ error: "Invalid request", ...(findings.length > 0 ? { findings } : {}) });
      return;
    }
    if (error instanceof AuthFailure || error instanceof ProjectFailure || error instanceof TaskFailure || error instanceof HermesAgentFailure) {
      const fields = { requestId: request.id, method: request.method, url: request.url, statusCode: error.statusCode, error: redact(error.publicMessage), ...(error instanceof ProjectFailure || error instanceof TaskFailure ? { findings: redact(error.findings) } : {}) };
      if (error.statusCode >= 500) request.log.error({ ...fields, err: error }, "Request failed"); else request.log.warn(fields, "Request rejected");
      sendDomainFailure(reply, error);
      return;
    }
    if (typeof error === "object" && error !== null && "code" in error && error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      request.log.warn({ requestId: request.id, statusCode: 413 }, "Request rejected");
      reply.code(413).send({ error: "Request is too large", findings: [{ code: "request-too-large", field: "images", message: "Attach fewer or smaller images and submit again" }] }); return;
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ requestId: request.id, method: error.method, url: error.url, issues: error.cause.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message })) }, "Response doesn't match the schema");
      reply.code(500).send({ error: "Internal server error" });
      return;
    }
    request.log.error({ requestId: request.id, method: request.method, url: request.url, error: redact(error instanceof Error ? error.message : String(error)) }, "Unhandled request error");
    reply.code(500).send({ error: "Internal server error" });
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith("/api/")) {
      reply.code(404).send({ error: "Not found" });
      return;
    }
    reply.code(404).type("text/plain; charset=utf-8").send("Not found");
  });
}
