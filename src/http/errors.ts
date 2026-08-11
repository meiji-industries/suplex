import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { AuthFailure } from "../auth.js";
import { ProjectFailure } from "../projects.js";
import { TaskFailure } from "../tasks.js";
import { redact } from "../logging.js";

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

function sendDomainFailure(reply: FastifyReply, error: AuthFailure | ProjectFailure | TaskFailure): void {
  const body = error instanceof AuthFailure
    ? { error: error.publicMessage }
    : { error: error.publicMessage, findings: error.findings };
  reply.code(error.statusCode).send(body);
}

export function installHttpErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (isValidationError(error)) {
      const findings = validationFindings(error);
      reply.code(400).send({ error: "Invalid request", ...(findings.length > 0 ? { findings } : {}) });
      return;
    }
    if (error instanceof AuthFailure || error instanceof ProjectFailure || error instanceof TaskFailure) {
      sendDomainFailure(reply, error);
      return;
    }
    request.log.error({ requestId: request.id, error: redact(error instanceof Error ? error.message : String(error)) }, "Unhandled request error");
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
