import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";

import { createInterface, type Interface } from "node:readline";
import { z } from "zod";
import { AdvisorBridgeBindingSchema, advisorReportInputSchema, validateAdvisorSubmission, type AdvisorResult, type AdvisorRole } from "./advisor-report.js";
import { ADVISOR_BRIDGE_BINDING_ENV, ADVISOR_BRIDGE_RESULT_ENV, ADVISOR_BRIDGE_TOKEN_ENV, authenticateBridgeToken, bridgeBindingPath } from "./bridge-auth.js";
import { isEntrypoint } from "../shared/entrypoint.js";

const JsonRpcEnvelopeSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.unknown().optional() }).strict();
type Writable = { write(chunk: string): boolean };

export function startAdvisorReportBridgeTransport(input: { role: AdvisorRole; stdin: NodeJS.ReadableStream; stdout: Writable; capture?: (result: AdvisorResult) => Promise<void> }): Interface {
  const lineReader = createInterface({ input: input.stdin, crlfDelay: Infinity });
  let initialized = false;
  const respond = (id: string | number, result: unknown): void => { input.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); };
  const fail = (id: string | number | null, code: number, message: string): void => { input.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`); };
  const handleLine = async (line: string): Promise<void> => {
    let request: z.infer<typeof JsonRpcEnvelopeSchema> | undefined;
    try {
      request = JsonRpcEnvelopeSchema.parse(JSON.parse(line));
      if (request.method === "notifications/initialized") {
        if (!initialized) throw new Error("MCP client sent initialized before initialize");
        return;
      }
      if (request.id === undefined) throw new Error("MCP notification is unsupported");
      if (request.method === "initialize") {
        const params = z.object({ protocolVersion: z.string(), capabilities: z.object({}).passthrough(), clientInfo: z.object({ name: z.string(), version: z.string() }).passthrough() }).strict().parse(request.params);
        initialized = true;
        respond(request.id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "suplex-advisor-report", version: "1" } });
        return;
      }
      if (!initialized) throw new Error("MCP client must initialize before calling tools");
      if (request.method === "tools/list") {
        respond(request.id, { tools: [{ name: "submit_report", description: "Submit the complete structured result for this Advisor assignment.", inputSchema: advisorReportInputSchema(input.role) }] });
        return;
      }
      if (request.method !== "tools/call") {
        fail(request.id, -32601, "MCP method is unsupported");
        return;
      }
      const params = z.object({ name: z.literal("submit_report"), arguments: z.object({ _meta: z.unknown().optional() }).passthrough(), _meta: z.unknown().optional() }).strict().parse(request.params);
      const submission = { ...params.arguments };
      delete submission._meta;
      const outcome = validateAdvisorSubmission(input.role, submission);
      if (!outcome.result) {
        respond(request.id, { content: [{ type: "text", text: outcome.invalidReason }], isError: true });
        return;
      }
      await input.capture?.(outcome.result);
      respond(request.id, { content: [{ type: "text", text: JSON.stringify(outcome.result) }], structuredContent: outcome.result });
    } catch (error) {
      const id = typeof request?.id === "string" || typeof request?.id === "number" ? request.id : null;
      fail(id, -32600, error instanceof Error ? error.message : "Advisor report bridge failed");
    }
  };
  let queue = Promise.resolve();
  lineReader.on("line", line => { queue = queue.then(() => handleLine(line)); });
  return lineReader;
}

async function runAdvisorReportBridge(): Promise<void> {
  const bindingPath = bridgeBindingPath(process.env, ADVISOR_BRIDGE_BINDING_ENV, "Advisor report");
  const binding = AdvisorBridgeBindingSchema.parse(JSON.parse(await readFile(bindingPath, "utf8")));
  authenticateBridgeToken(binding.token, process.env, ADVISOR_BRIDGE_TOKEN_ENV, "Advisor report");
  const resultPath = process.env[ADVISOR_BRIDGE_RESULT_ENV];
  const capture = resultPath ? async (result: AdvisorResult): Promise<void> => {
    const pending = `${resultPath}.${randomUUID()}.pending`;
    await writeFile(pending, JSON.stringify(result), { mode: 0o600 });
    await rename(pending, resultPath);
  } : undefined;
  startAdvisorReportBridgeTransport({ role: binding.role, stdin: process.stdin, stdout: process.stdout, ...(capture ? { capture } : {}) });
}

if (isEntrypoint(import.meta.url)) {
  void runAdvisorReportBridge().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Advisor report bridge failed"}\n`);
    process.exitCode = 1;
  });
}
