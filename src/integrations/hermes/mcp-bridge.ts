import type { Interface } from "node:readline";
import { z } from "zod";

import {
  HermesTaskCommandBodySchema,
  HermesTaskCreateBodySchema,
  HermesTaskDependenciesBodySchema,
  HermesTaskIdParamsSchema,
  HermesTaskListQuerySchema,
  HermesProjectDiscoveryQuerySchema,
} from "../../http/contracts/hermes.js";
import { startMcpStdioTransport, type McpTool } from "../../shared/mcp-stdio.js";

const AUTHORITY = "Human answers, delivery, releases, and merges stay human authority and are unavailable here.";

const TaskIdSchema = HermesTaskIdParamsSchema.shape.taskId;
const GetTaskSchema = z.object({
  taskId: TaskIdSchema,
  knownRevision: z.string().min(1).max(256).optional(),
}).strict();
const TaskOnlySchema = z.object({ taskId: TaskIdSchema }).strict();
const CommandTaskSchema = HermesTaskCommandBodySchema.extend({ taskId: TaskIdSchema });
const SetDependenciesSchema = HermesTaskDependenciesBodySchema.extend({ taskId: TaskIdSchema });
const NoArgumentsSchema = z.object({}).strict();

const toolSchema = (schema: z.ZodType): Record<string, unknown> => z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;

/** Every tool maps onto one existing Hermes runtime route; the server stays the sole authority on task rules. */
export const HERMES_MCP_TOOLS: readonly McpTool[] = [
  { name: "forge_whoami", description: `Read this paired agent's identity, capabilities, and granted projects with the create-time agentTaskPolicy each one permits. ${AUTHORITY}`, inputSchema: toolSchema(NoArgumentsSchema) },
  { name: "forge_capabilities", description: `Read the runtime capability contract, autonomous commands, and unavailable commands. ${AUTHORITY}`, inputSchema: toolSchema(NoArgumentsSchema) },
  { name: "forge_list_workflows", description: "List workflow records for one granted project and whether task creation permits each record.", inputSchema: toolSchema(HermesProjectDiscoveryQuerySchema) },
  { name: "forge_list_templates", description: "List task templates for one granted project and whether task creation permits each template.", inputSchema: toolSchema(HermesProjectDiscoveryQuerySchema) },
  { name: "forge_list_tasks", description: "List tasks this agent created, newest update first. Filters and the opaque cursor come from the runtime contract.", inputSchema: toolSchema(HermesTaskListQuerySchema) },
  { name: "forge_get_task", description: "Read one task. Pass knownRevision to poll conditionally: an unchanged task returns { unchanged: true, revision } instead of the projection.", inputSchema: toolSchema(GetTaskSchema) },
  { name: "forge_get_task_delivery", description: `Read the delivery and blocker state of one task, including any pull request, delivery wait, and completion observation. Forge reports no persisted check observation. ${AUTHORITY}`, inputSchema: toolSchema(TaskOnlySchema) },
  { name: "forge_create_task", description: `Create a backlog task. It never starts execution; use forge_command_task with start_task for that. dependsOn sets its prerequisites, shown as Blocked by. idempotencyKey is required and scoped to this agent: an identical replay returns the same task, and reusing the key for a different request fails with idempotency_conflict. deliveryTarget, runProjectTests, and visualEvidence must match the project agentTaskPolicy from forge_whoami; anything else fails with delivery_policy_rejected. ${AUTHORITY}`, inputSchema: toolSchema(HermesTaskCreateBodySchema) },
  { name: "forge_set_task_dependencies", description: "Replace the prerequisites (dependsOn, shown as Blocked by) of a task with the complete set given. An empty array removes every prerequisite. Each prerequisite must be a task this agent created; a self-reference, a cycle, or an unavailable task is rejected and the current set stays. forge_get_task reads the same set back as dependsOn and blockedBy.", inputSchema: toolSchema(SetDependenciesSchema) },
  { name: "forge_command_task", description: `Apply one lifecycle command to a task. revision must be the task's current revision (a stale one fails with revision_stale) and idempotencyKey is required. start_task, cancel_task, and archive_task are not reversible by this agent. note is only accepted by send_task_note. ${AUTHORITY}`, inputSchema: toolSchema(CommandTaskSchema) },
];

export class HermesBridgeFailure extends Error {
  constructor(readonly code: "configuration_missing", message: string) {
    super(message);
    this.name = "HermesBridgeFailure";
  }
}

export interface HermesBridgeSettings {
  baseUrl: string;
  credential: string;
}

/** Reads the bridge settings from the environment only; no tool or command line ever carries the credential. */
export function readHermesBridgeSettings(environment: NodeJS.ProcessEnv): { baseUrl: string; credential: string } {
  const baseUrl = environment.FORGE_BASE_URL?.trim();
  const credential = environment.FORGE_AGENT_CREDENTIAL?.trim();
  if (!baseUrl) throw new HermesBridgeFailure("configuration_missing", "Set FORGE_BASE_URL in $HERMES_HOME/.env before starting the Forge MCP bridge.");
  if (!credential) throw new HermesBridgeFailure("configuration_missing", "Set FORGE_AGENT_CREDENTIAL in $HERMES_HOME/.env before starting the Forge MCP bridge.");
  return { baseUrl: baseUrl.replace(/\/+$/, ""), credential };
}

export class HermesMcpBridge {
  private readonly baseUrl: string;
  private readonly credential: string;

  constructor(settings: HermesBridgeSettings) {
    this.baseUrl = settings.baseUrl.replace(/\/+$/, "");
    this.credential = settings.credential;
  }

  /** Replaces the credential anywhere it could reach a transcript, log, or tool result. */
  redact(text: string): string {
    return this.credential ? text.split(this.credential).join("[redacted credential]") : text;
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "forge_whoami":
        return this.request("GET", "/api/hermes/me");
      case "forge_capabilities":
        return this.request("GET", "/api/hermes/capabilities");
      case "forge_list_workflows": {
        const query = HermesProjectDiscoveryQuerySchema.parse(args);
        return this.request("GET", `/api/hermes/workflows?${new URLSearchParams(query).toString()}`);
      }
      case "forge_list_templates": {
        const query = HermesProjectDiscoveryQuerySchema.parse(args);
        return this.request("GET", `/api/hermes/templates?${new URLSearchParams(query).toString()}`);
      }
      case "forge_list_tasks": {
        const query = HermesTaskListQuerySchema.parse(args);
        const search = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
        return this.request("GET", `/api/hermes/tasks?${search.toString()}`);
      }
      case "forge_get_task": {
        const input = GetTaskSchema.parse(args);
        const result = await this.request("GET", `/api/hermes/tasks/${encodeURIComponent(input.taskId)}`, {
          headers: input.knownRevision === undefined ? {} : { "If-None-Match": `"${input.knownRevision}"` },
        });
        return result.status === 304 ? { unchanged: true, revision: input.knownRevision } : result;
      }
      case "forge_get_task_delivery": {
        const input = TaskOnlySchema.parse(args);
        const result = await this.request("GET", `/api/hermes/tasks/${encodeURIComponent(input.taskId)}`);
        const task = result.body as { id?: string; status?: string; revision?: string; blocker?: unknown; delivery?: unknown };
        if (result.status !== 200) return result;
        return { status: 200, body: { taskId: task.id, taskStatus: task.status, revision: task.revision, blocker: task.blocker ?? null, delivery: task.delivery ?? null } };
      }
      case "forge_create_task":
        return this.request("POST", "/api/hermes/tasks", { body: HermesTaskCreateBodySchema.parse(args) });
      case "forge_set_task_dependencies": {
        const { taskId, ...rest } = SetDependenciesSchema.parse(args);
        return this.request("PUT", `/api/hermes/tasks/${encodeURIComponent(taskId)}/dependencies`, { body: HermesTaskDependenciesBodySchema.parse(rest) });
      }
      case "forge_command_task": {
        const { taskId, ...rest } = CommandTaskSchema.parse(args);
        return this.request("POST", `/api/hermes/tasks/${encodeURIComponent(taskId)}/commands`, { body: HermesTaskCommandBodySchema.parse(rest) });
      }
      default:
        throw new Error(`Forge MCP tool is unsupported: ${name}`);
    }
  }

  private async request(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.credential}`,
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      throw new Error(this.redact(`Forge is unreachable at ${this.baseUrl}: ${error instanceof Error ? error.message : "request failed"}`));
    }
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text); }
      catch { body = { error: "Forge returned a response that is not JSON", code: "internal_error" }; }
    }
    return { status: response.status, body };
  }
}

const failed = (result: unknown): boolean => {
  const status = (result as { status?: number }).status;
  return typeof status === "number" && status >= 400;
};

export function startHermesMcpTransport(input: { bridge: HermesMcpBridge; stdin: NodeJS.ReadableStream; stdout: { write(chunk: string): boolean } }): Interface {
  return startMcpStdioTransport({
    serverName: "forge-hermes-bridge",
    tools: HERMES_MCP_TOOLS,
    call: async (name, args) => input.bridge.call(name, args),
    present: (result) => {
      const redacted: unknown = JSON.parse(input.bridge.redact(JSON.stringify(result) ?? "null"));
      return { content: [{ type: "text", text: JSON.stringify(redacted) }], structuredContent: redacted, ...(failed(redacted) ? { isError: true } : {}) };
    },
    failureMessage: "Forge MCP bridge failed",
    stdin: input.stdin,
    stdout: input.stdout,
  });
}
