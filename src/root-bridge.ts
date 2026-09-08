import { createInterface, type Interface } from "node:readline";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
  RootBridgeConfigSchema,
  RootToolSchema,
  rootToolInputSchema,
  RootImageResultSchema,
  type RootImageResult,
  type RootBridgeConfig,
  type RootIdentity,
  type RootTool,
  type WorkerAssignment,
  type AdvisorRequest,
} from "./root-contracts.js";
import { ForgeDatabase } from "./database.js";
import { CliHerdrClient } from "./herdr-client.js";
import { RootController } from "./root-controller.js";
import { TaskControlStore } from "./root-session-store.js";
import { createTaskHarness, nativeSessionReader } from "./task-harness-registry.js";
import { ArtifactStore } from "./artifacts.js";
import { configureProcessLogSink, createDevLogFileSink } from "./logging.js";
import { taskEvidenceRoot } from "./workflow-evidence.js";

export class RootBridgeFailure extends Error {
  constructor(readonly code: "invalid_request" | "root_identity_mismatch" | "task_tool_busy", message: string) {
    super(message);
    this.name = "RootBridgeFailure";
  }
}

export interface RootBridgeAdapter {
  assertCurrentRoot(root: RootIdentity): Promise<void>;
  /** Claims the task's tool-owner token for this bridge process, or null while another live bridge owns it. */
  claimToolOwner(root: RootIdentity): Promise<string | null>;
  releaseToolOwner(root: RootIdentity, token: string): Promise<void>;
  observe(root: RootIdentity): Promise<unknown>;
  readImage(root: RootIdentity, artifactId: string): Promise<RootImageResult>;
  readWorkerEvidence(root: RootIdentity, turnId: string, cursor?: string, maxCharacters?: number): Promise<unknown>;
  delegateWorker(root: RootIdentity, assignment: WorkerAssignment): Promise<unknown>;
  delegateAdvisor(root: RootIdentity, request: AdvisorRequest): Promise<unknown>;
  requestDelivery(root: RootIdentity, operation: Extract<RootTool, { kind: "request_delivery" }>['operation'], expectedHead?: string, review?: Extract<RootTool, { kind: "request_delivery" }>['review']): Promise<unknown>;
  requestDelivery(root: RootIdentity, operation: Extract<RootTool, { kind: "request_delivery" }>['operation'], expectedHead?: string, review?: Extract<RootTool, { kind: "request_delivery" }>['review'], pullRequestTitle?: Extract<RootTool, { kind: "request_delivery" }>['pullRequestTitle']): Promise<unknown>;
  askHuman(root: RootIdentity, question: string, options: Extract<RootTool, { kind: "ask_human" }>['options']): Promise<unknown>;
}

export class RootBridge {
  constructor(private readonly root: RootIdentity, private readonly adapter: RootBridgeAdapter) {}

  async call(raw: unknown): Promise<unknown> {
    const parsed = RootToolSchema.safeParse(raw);
    if (!parsed.success)
      throw new RootBridgeFailure("invalid_request", `Coordinator bridge request is invalid: ${parsed.error.issues.map(issue => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ")}`);
    await this.adapter.assertCurrentRoot(this.root);
    const token = await this.adapter.claimToolOwner(this.root);
    if (token === null) throw new RootBridgeFailure("task_tool_busy", "Another Forge tool call for this task is still in progress. Retry after it finishes.");
    try { return await this.dispatch(parsed.data); }
    finally { await this.adapter.releaseToolOwner(this.root, token); }
  }

  private async dispatch(tool: RootTool): Promise<unknown> {
    switch (tool.kind) {
      case "observe":
        return this.adapter.observe(this.root);
      case "read_image":
        return this.adapter.readImage(this.root, tool.artifactId);
      case "read_worker_evidence":
        return this.adapter.readWorkerEvidence(this.root, tool.turnId, tool.cursor, tool.maxCharacters);
      case "delegate_worker":
        return this.adapter.delegateWorker(this.root, { plan: tool.plan, acceptanceCriteria: tool.acceptanceCriteria, instruction: tool.instruction, mode: tool.mode, purpose: tool.purpose, advisorTurnId: tool.advisorTurnId, candidateTurnIds: tool.candidateTurnIds, advisorSessionId: tool.advisorSessionId, candidateSessionIds: tool.candidateSessionIds });
      case "delegate_advisor":
        return this.adapter.delegateAdvisor(this.root, { role: tool.role, ...(tool.brief === undefined ? {} : { brief: tool.brief }) });
      case "request_delivery":
        return this.adapter.requestDelivery(this.root, tool.operation, tool.expectedHead, tool.review, tool.pullRequestTitle);
      case "ask_human":
        return this.adapter.askHuman(this.root, tool.question, tool.options);
    }
  }
}

const JsonRpcEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
}).strict();

type Writable = { write(chunk: string): boolean };

export function rootBridgeMcpConfig(config: RootBridgeConfig): { mcpServers: Record<string, { command: string; args: string[] }> } {
  const valid = RootBridgeConfigSchema.parse(config);
  return { mcpServers: { forge_root: valid.server } };
}

export function startRootBridgeTransport(input: {
  bridge: RootBridge;
  stdin: NodeJS.ReadableStream;
  stdout: Writable;
}): Interface {
  const lineReader = createInterface({ input: input.stdin, crlfDelay: Infinity });
  let initialized = false;
  const respond = (id: string | number, result: unknown): void => {
    input.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  };
  const fail = (id: string | number | null, code: number, message: string): void => {
    input.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
  };
  lineReader.on("line", async (line) => {
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
        respond(request.id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "forge-root-bridge", version: "1" } });
        return;
      }
      if (!initialized) throw new Error("MCP client must initialize before calling tools");
      if (request.method === "tools/list") {
        respond(request.id, { tools: [{ name: "forge_root", description: "Observe this task or request a Forge-owned delivery action.", inputSchema: rootToolInputSchema() }] });
        return;
      }
      if (request.method !== "tools/call") {
        fail(request.id, -32601, "MCP method is unsupported");
        return;
      }
      const params = z.object({ name: z.literal("forge_root"), arguments: z.object({ _meta: z.unknown().optional() }).passthrough(), _meta: z.unknown().optional() }).strict().parse(request.params);
      try {
        const argumentsWithoutMetadata = { ...params.arguments };
        delete argumentsWithoutMetadata._meta;
        const result = await input.bridge.call(argumentsWithoutMetadata);
        const image = RootImageResultSchema.safeParse(result);
        if (image.success) respond(request.id, { content: [{ type: "text", text: image.data.filename }, { type: "image", data: image.data.data, mimeType: image.data.mimeType }] });
        else respond(request.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Coordinator bridge failed";
        respond(request.id, { content: [{ type: "text", text: message }], isError: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Coordinator bridge failed";
      const id = typeof request?.id === "string" || typeof request?.id === "number" ? request.id : null;
      fail(id, -32600, message);
    }
  });
  return lineReader;
}

async function runRootBridge(): Promise<void> {
  const bindingIndex = process.argv.indexOf("--binding");
  const bindingPath = bindingIndex >= 0 ? process.argv[bindingIndex + 1] : undefined;
  if (!bindingPath) throw new Error("Coordinator bridge requires --binding <path>");
  const fileSink = createDevLogFileSink("worker", join(dirname(bindingPath), "logs"));
  configureProcessLogSink(line => { fileSink(line); process.stderr.write(line); });
  const config = RootBridgeConfigSchema.parse(JSON.parse(await readFile(bindingPath, "utf8")));
  const databasePath = config.databasePath;
  if (!databasePath) throw new Error("Coordinator bridge binding has no server database path");
  const database = new ForgeDatabase(databasePath, { migrate: false });
  const herdr = new CliHerdrClient();
  const store = new TaskControlStore(database);
  const controller = new RootController(store, createTaskHarness(databasePath, herdr, { artifactRoot: config.artifactRoot }), undefined, new ArtifactStore(config.artifactRoot), { root: taskEvidenceRoot(databasePath) }, session => nativeSessionReader(databasePath, session));
  startRootBridgeTransport({ bridge: new RootBridge(config.root, controller), stdin: process.stdin, stdout: process.stdout });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runRootBridge().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Coordinator bridge failed"}\n`);
    process.exitCode = 1;
  });
}
