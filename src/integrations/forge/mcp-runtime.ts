import {
  AgentApiProjectDiscoveryQuerySchema,
  AgentApiTaskCommandBodySchema,
  AgentApiTaskCreateBodySchema,
  AgentApiTaskDependenciesBodySchema,
  AgentApiTaskIdParamsSchema,
  AgentApiTaskListQuerySchema,
  agentApiCapabilities,
} from "../../http/contracts/agent-api.js";
import type { ExternalAgentPrincipal } from "../../identity/external-agents.js";
import type { AgentApiGithubPort, TaskService } from "../../tasks/tasks.js";
import type { TaskHost } from "../../tasks/host.js";
import { z } from "zod";

const TaskIdSchema = AgentApiTaskIdParamsSchema.shape.taskId;
const GetTaskSchema = z.object({ taskId: TaskIdSchema, knownRevision: z.string().min(1).max(256).optional() }).strict();
const TaskOnlySchema = z.object({ taskId: TaskIdSchema }).strict();
const CommandTaskSchema = AgentApiTaskCommandBodySchema.extend({ taskId: TaskIdSchema });
const SetDependenciesSchema = AgentApiTaskDependenciesBodySchema.extend({ taskId: TaskIdSchema });

export class ForgeMcpRuntime {
  constructor(private readonly input: { principal: ExternalAgentPrincipal; tasks: TaskService; agentDelivery: boolean; host?: Pick<TaskHost, "recover">; github?: AgentApiGithubPort; logRecoveryFailure?: (taskId: string, error: unknown) => void }) {}

  async call(name: string, args: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const { principal, tasks } = this.input;
    switch (name) {
      case "forge_whoami": return { status: 200, body: tasks.agentApiIdentity(principal) };
      case "forge_capabilities": return { status: 200, body: agentApiCapabilities(this.input.agentDelivery) };
      case "forge_list_workflows": {
        const query = AgentApiProjectDiscoveryQuerySchema.parse(args);
        return { status: 200, body: { workflows: tasks.listAgentApiWorkflows(principal, query.projectId) } };
      }
      case "forge_list_templates": {
        const query = AgentApiProjectDiscoveryQuerySchema.parse(args);
        return { status: 200, body: { templates: tasks.listAgentApiTemplates(principal, query.projectId) } };
      }
      case "forge_list_tasks": {
        const query = AgentApiTaskListQuerySchema.parse(args);
        return { status: 200, body: await tasks.readAgentApiTasks(principal, { limit: query.limit, ...(query.projectId === undefined ? {} : { projectId: query.projectId }), ...(query.status === undefined ? {} : { status: query.status }), ...(query.pullRequestNumber === undefined ? {} : { pullRequestNumber: query.pullRequestNumber }), ...(query.sourceBranch === undefined ? {} : { sourceBranch: query.sourceBranch }), ...(query.titleContains === undefined ? {} : { titleContains: query.titleContains }), ...(query.updatedSince === undefined ? {} : { updatedSince: query.updatedSince }), ...(query.cursor === undefined ? {} : { cursor: query.cursor }), ...(query.archived === undefined ? {} : { archived: query.archived === "true" }), ...(query.attention === undefined ? {} : { attention: query.attention === "true" }), ...(query.blocker === undefined ? {} : { blocker: query.blocker === "true" }), ...(query.filter === undefined ? {} : { filter: query.filter }), view: query.view ?? "summary" }, this.input.github) };
      }
      case "forge_get_task": {
        const input = GetTaskSchema.parse(args);
        const task = await tasks.readAgentApiTask(principal, input.taskId, this.input.github);
        if (input.knownRevision === task.revision) return { status: 304, body: { unchanged: true, revision: task.revision } };
        return { status: 200, body: task };
      }
      case "forge_get_task_delivery": {
        const input = TaskOnlySchema.parse(args);
        const task = await tasks.readAgentApiTask(principal, input.taskId, this.input.github);
        return { status: 200, body: { taskId: task.id, taskStatus: task.status, revision: task.revision, queue: task.queue ?? null, blocker: task.blocker ?? null, delivery: task.delivery ?? null } };
      }
      case "forge_create_task": {
        const result = await tasks.createTaskForAgentApi(principal, AgentApiTaskCreateBodySchema.parse(args));
        if (result.task.status === "active") this.recover(result.task.id);
        return { status: result.created ? 201 : 200, body: await tasks.readAgentApiTask(principal, result.task.id, this.input.github) };
      }
      case "forge_set_task_dependencies": {
        const { taskId, ...body } = SetDependenciesSchema.parse(args);
        return { status: 200, body: tasks.setAgentApiTaskDependencies(principal, taskId, AgentApiTaskDependenciesBodySchema.parse(body).dependsOn) };
      }
      case "forge_command_task": {
        const { taskId, ...body } = CommandTaskSchema.parse(args);
        const parsed = AgentApiTaskCommandBodySchema.parse(body);
        const task = await tasks.commandAgentApiTask(principal, taskId, parsed);
        if (["start_task", "cancel_task", "send_task_note", "recheck_delivery_wait"].includes(parsed.command)) this.recover(task.id);
        return { status: 200, body: task };
      }
      default: throw new Error(`Forge MCP tool is unsupported: ${name}`);
    }
  }

  private recover(taskId: string): void {
    void this.input.host?.recover(taskId).catch((error) => this.input.logRecoveryFailure?.(taskId, error));
  }
}

export function presentForgeMcpResult(result: { status: number; body: unknown }): unknown {
  return result.status === 304 ? result.body : result;
}
