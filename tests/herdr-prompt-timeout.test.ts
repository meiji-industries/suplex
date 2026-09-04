import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";
import { z } from "zod";

import { ForgeDatabase } from "../src/database.js";
import { HerdrFailure } from "../src/herdr-client.js";
import { HerdrTurnRunner, type HerdrTurnInput } from "../src/herdr-turn-runner.js";
import { IssueTimelineEvents } from "../src/issue-timeline-events.js";

const ResultSchema = z.object({ status: z.literal("ok") });
const pause = async () => undefined;
const resultPath = (prompt: string) => /Atomically write exactly one JSON object to (.+?) \(write a sibling/.exec(prompt)?.[1];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-herdr-prompt-timeout-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const now = new Date().toISOString();
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'owner/repo', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief.md', ?)").run("a".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("b".repeat(64), now, now);
    db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, codex_session_id, agent_name, pane_id, status, created_at, updated_at) VALUES ('session', 'task', 'planner', 1, 1, 'codex', 'session', 'planner', 'pane', 'ready', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at, heartbeat_at) VALUES ('execution', 'task', 'company', 'workflow', 'planner', 'running', 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES ('task', 'company', 'project', 'workflow', 1, 'planning', 'lead', '[]', NULL, ?, 'event')").run(now);
  });
  const session = { id: "session", provider: "codex" as const, agentName: "planner", paneId: "pane", codexSessionId: "session", generation: 1, rolloutPath: undefined, live: { name: "planner", paneId: "pane", status: "working" } };
  const input: HerdrTurnInput<z.infer<typeof ResultSchema>> = { task: { taskId: "task", projectId: "project", projectSlug: "project", worktreePath: "/worktree", runtimeRoot: root }, executionRole: "planner", ledger: "agent", executionId: "execution", promptKind: "plan", prompt: "Plan this", profile: { model: "gpt", reasoningLevel: "high", servicePriority: "priority" }, resultSchema: ResultSchema, schemaPath: "schema.json", companyId: "company", workflowId: "workflow", revision: 1 };
  return { root, database, session, input };
}

test("a timed-out prompt observes a working agent and waits for its result", async () => {
  const value = await fixture();
  let prompts = 0;
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      prompts += 1;
      await writeFile(resultPath(prompt)!, JSON.stringify({ status: "ok" }));
      throw new HerdrFailure("timeout", true, "timed out waiting for agent status");
    },
    getAgent: async () => value.session.live,
    readAgent: async () => "",
  };
  const runner = new HerdrTurnRunner(value.database, herdr as never, { ensureRoleSession: async () => value.session } as never, new IssueTimelineEvents(value.database), undefined, undefined, pause);
  try {
    await expect(runner.run(value.input)).resolves.toMatchObject({ result: { status: "ok" } });
    expect(prompts).toBe(1);
    expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_herdr_turns").get())).toEqual({ status: "completed" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("an idle timed-out prompt without delivery evidence fails and may retry its deterministic turn", async () => {
  const value = await fixture();
  let delivered = false;
  let prompts = 0;
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      prompts += 1;
      if (delivered) {
        await writeFile(resultPath(prompt)!, JSON.stringify({ status: "ok" }));
        return value.session.live;
      }
      throw new HerdrFailure("timeout", true, "timed out waiting for agent status");
    },
    getAgent: async () => delivered ? value.session.live : { ...value.session.live, status: "idle" },
    readAgent: async () => "no forge prompt here",
  };
  const runner = new HerdrTurnRunner(value.database, herdr as never, { ensureRoleSession: async () => value.session } as never, new IssueTimelineEvents(value.database), undefined, undefined, pause);
  try {
    await expect(runner.run(value.input)).rejects.toMatchObject({ code: "prompt-not-delivered" });
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code AS failureCode FROM forge_agent_executions WHERE id = 'execution'").get())).toEqual({ status: "failed", failureCode: "prompt-not-delivered" });
    value.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'running' WHERE id = 'execution'").run());
    delivered = true;
    await expect(runner.run(value.input)).resolves.toMatchObject({ result: { status: "ok" } });
    expect(prompts).toBe(2);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});
