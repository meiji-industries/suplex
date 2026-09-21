import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { expect, test } from "vitest";

import { DISCOVERY_ARTIFACT_PATHS } from "../src/http/routes/discovery.js";
import { FORGE_MCP_TOOLS, ForgeMcpBridge, startForgeMcpTransport } from "../src/integrations/forge/mcp-bridge.js";
import { nativeApp } from "./helpers/native-app.js";

type JsonRecord = Record<string, unknown>;

/**
 * The whole journey of an agent that never opens the Forge web application: read the
 * public artifacts, pair, discover the contract, work only inside its grants, and be
 * denied everything else without learning what exists.
 */

function mcpSession(settings: { baseUrl: string; credential: string }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const responses: unknown[] = [];
  stdout.on("data", (chunk: Buffer) => { for (const line of chunk.toString().split("\n").filter(Boolean)) responses.push(JSON.parse(line)); });
  const reader = startForgeMcpTransport({ bridge: new ForgeMcpBridge(settings), stdin, stdout });
  let id = 0;
  return {
    async call(request: JsonRecord): Promise<JsonRecord> {
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++id, ...request })}\n`);
      await expect.poll(() => responses.length, { timeout: 5000 }).toBeGreaterThan(0);
      return responses.shift() as JsonRecord;
    },
    close: () => { reader.close(); stdin.destroy(); },
  };
}

const tool = (name: string, args: JsonRecord): JsonRecord => ({ method: "tools/call", params: { name, arguments: args } });
const structured = (response: JsonRecord): JsonRecord => (response.result as { structuredContent: JsonRecord }).structuredContent;

test("a paired agent completes the whole task journey without the web application", async () => {
  const logLines: string[] = [];
  const transcript: string[] = [];
  const record = (label: string, value: unknown): void => { transcript.push(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`); };

  const fixture = await nativeApp({ logSink: (line) => { logLines.push(line); } });
  let session: ReturnType<typeof mcpSession> | undefined;
  try {
    // An operator provisions a fresh company, a project named forge, and an agent scoped to it.
    const company = fixture.auth.createCompany(fixture.userId, "Machine Discovery Company");
    const repositoryPath = join(fixture.config.repositoryRoot, "forge");
    const worktreeRoot = join(fixture.config.worktreeRoot, "forge");
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(worktreeRoot, { recursive: true });
    const forgeProject = await fixture.projects.createProject(fixture.userId, company.id, { name: "forge", repositoryPath, worktreeRoot, repository: "owner/forge", baseBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker" });
    const ungrantedProject = fixture.project;
    // A real task the agent must never see, so the denial is proven to conceal rather than to be empty.
    const ungrantedTaskId = (await fixture.tasks.createTask(fixture.userId, fixture.company.id, { projectId: ungrantedProject.id, title: "Out of grant", description: "Not for this agent", idempotencyKey: "out-of-grant-1", startImmediately: false })).task.id;

    const issued = fixture.externalAgent.create(fixture.userId, { name: "Machine Discovery Bot", companyId: company.id, projectIds: [forgeProject.id] });
    const pairingCode = issued.pairingCode;

    const baseUrl = await fixture.app.listen({ port: 0, host: "127.0.0.1" });

    // 1. Discovery before any credential exists.
    const artifacts: Record<string, string> = {};
    for (const path of DISCOVERY_ARTIFACT_PATHS) {
      const response = await fixture.app.inject({ method: "GET", url: path });
      expect(response.statusCode, path).toBe(200);
      artifacts[path] = response.body;
      record(`artifact ${path}`, response.body);
    }
    const catalog = JSON.parse(artifacts["/.well-known/forge/api-catalog.json"]!) as { pairing: Array<{ path: string; method: string }>; runtime: Array<{ path: string; method: string }> };
    const exchangePath = catalog.pairing[0]!.path;
    const skills = JSON.parse(artifacts["/.well-known/forge/agent-skills.json"]!) as { skills: Array<{ clients: Array<{ transport: string; preferred: boolean; tools?: string[] }> }> };
    const preferred = skills.skills[0]!.clients.find(client => client.preferred)!;
    expect(preferred.transport).toBe("mcp-stdio");
    expect(preferred.tools).toEqual(FORGE_MCP_TOOLS.map(entry => entry.name));

    // 2. Pair once, in the way the catalog describes.
    const exchanged = await fixture.app.inject({ method: "POST", url: exchangePath, payload: { pairingCode, profileId: "machine-discovery-profile" } });
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    const credential = exchanged.json().credential as string;
    expect(credential).toMatch(/^fha_/);

    // 3. Read the authoritative contract with the new credential.
    const openApiResponse = await fixture.app.inject({ method: "GET", url: "/api/agent/openapi.json", headers: { Authorization: `Bearer ${credential}` } });
    expect(openApiResponse.statusCode).toBe(200);
    const openApi = openApiResponse.json() as { paths: Record<string, JsonRecord> };
    record("openapi", openApi);
    for (const entry of catalog.runtime) {
      if (!entry.path.includes("{")) continue;
      expect(Object.keys(openApi.paths), `${entry.path} is missing from the served contract`).toContain(entry.path);
    }
    expect(Object.keys(openApi.paths)).toContain("/api/agent/tasks");

    // 4. Establish the preferred client path.
    session = mcpSession({ baseUrl, credential });
    const initialized = await session.call({ method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "machine-discovery", version: "1" } } });
    expect(initialized).toMatchObject({ result: { serverInfo: { name: "forge-agent-bridge" } } });
    record("initialize", initialized);

    // 5. Learn the allowed project from the credential's own identity, never from a list of everything.
    const whoami = await session.call(tool("forge_whoami", {}));
    record("whoami", whoami);
    const identity = structured(whoami).body as { agent: { id: string; name: string }; projects: Array<{ id: string; name: string }> };
    expect(identity.projects.map(entry => entry.name)).toEqual(["forge"]);
    expect(identity.projects.map(entry => entry.id)).toEqual([forgeProject.id]);
    const projectId = identity.projects.find(entry => entry.name === "forge")!.id;

    // 6. The project starts with no tasks.
    const emptyList = await session.call(tool("forge_list_tasks", { projectId, limit: 50 }));
    record("list before", emptyList);
    expect(structured(emptyList)).toMatchObject({ status: 200, body: { tasks: [], nextCursor: null } });

    // 7. Create one backlog task idempotently, and prove the replay is the same task.
    const declared = { projectId, title: "Publish the machine discovery artifacts", description: "Serve the public artifacts and document the operator handoff.", idempotencyKey: "machine-discovery-journey-1" };
    const created = await session.call(tool("forge_create_task", declared));
    record("create", created);
    const task = structured(created).body as { id: string; revision: string; title: string; status: string };
    expect(structured(created)).toMatchObject({ status: 201, body: { title: declared.title, status: "backlog" } });
    // The safe projection omits the description, so the declared properties are checked where they persist.
    const stored = fixture.tasks.getTask(fixture.userId, task.id);
    expect(stored.description).toBe(declared.description);
    expect(stored.projectId).toBe(projectId);

    const replayed = await session.call(tool("forge_create_task", declared));
    record("replay", replayed);
    expect(structured(replayed)).toMatchObject({ status: 200, body: { id: task.id, revision: task.revision, status: "backlog" } });
    expect(fixture.database.authQuery(db => (db.prepare("SELECT COUNT(*) AS count FROM forge_tasks WHERE project_id = ?").get(projectId) as { count: number }).count)).toBe(1);

    // 8. Poll it. An unchanged task answers without a body.
    const unchanged = await session.call(tool("forge_get_task", { taskId: task.id, knownRevision: task.revision }));
    record("poll unchanged", unchanged);
    expect(structured(unchanged)).toEqual({ unchanged: true, revision: task.revision });
    const polled = await session.call(tool("forge_get_task", { taskId: task.id }));
    record("poll", polled);
    expect(structured(polled)).toMatchObject({ status: 200, body: { id: task.id, status: "backlog", revision: task.revision } });

    // 9. Forbidden work is denied without telling the agent what exists.
    const outsideGrant = await session.call(tool("forge_create_task", { projectId: ungrantedProject.id, title: "Create outside the grant", idempotencyKey: "machine-discovery-forbidden-1" }));
    record("denied create", outsideGrant);
    expect(outsideGrant.result).toMatchObject({ isError: true });
    expect(structured(outsideGrant)).toMatchObject({ status: 404, body: { code: "not_found" } });
    expect(JSON.stringify(outsideGrant)).not.toContain(ungrantedProject.name);
    expect(JSON.stringify(outsideGrant)).not.toContain(fixture.company.id);
    // A project outside the grant and a project that does not exist answer identically.
    const missingProject = await session.call(tool("forge_create_task", { projectId: "project_does_not_exist", title: "Create in nothing", idempotencyKey: "machine-discovery-forbidden-1b" }));
    expect(structured(missingProject)).toEqual(structured(outsideGrant));

    const illegal = await session.call(tool("forge_command_task", { taskId: task.id, command: "unarchive_task", revision: task.revision, idempotencyKey: "machine-discovery-forbidden-2" }));
    record("denied command", illegal);
    expect(illegal.result).toMatchObject({ isError: true });
    expect(structured(illegal)).toMatchObject({ status: 409, body: { code: "illegal_command" } });

    const unknownTask = await session.call(tool("forge_get_task", { taskId: "task_does_not_exist" }));
    record("denied unknown", unknownTask);
    // A task outside the grant and a task that does not exist answer identically, so neither reveals the other.
    expect(structured(unknownTask)).toEqual(structured(await session.call(tool("forge_get_task", { taskId: ungrantedTaskId }))));
    expect(structured(unknownTask)).toMatchObject({ status: 404, body: { code: "resource_not_found" } });

    // Merging and answering a human stay outside the agent surface: no tool exists and the deployment says so.
    const capabilities = await session.call(tool("forge_capabilities", {}));
    record("capabilities", capabilities);
    expect((structured(capabilities).body as { unavailableCommands: string[] }).unavailableCommands).toContain("merge_pull_request");
    expect(FORGE_MCP_TOOLS.map(entry => entry.name)).not.toContain("forge_merge_task");

    // 10. Nothing ran. The task is still waiting for a person to start it.
    const final = await session.call(tool("forge_get_task", { taskId: task.id }));
    record("final", final);
    expect(structured(final)).toMatchObject({ status: 200, body: { id: task.id, status: "backlog", revision: task.revision } });
    const count = (sql: string, ...parameters: unknown[]): number => fixture.database.authQuery(db => (db.prepare(sql).get(...parameters) as { count: number }).count);
    expect(count("SELECT COUNT(*) AS count FROM forge_task_sessions")).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM forge_task_turns")).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM forge_audit_events WHERE action IN ('task_started', 'task_delivered', 'task_merged')")).toBe(0);
    expect(fixture.wakes).toEqual([]);

    // 11. Neither secret, nor its hash, reached any output an agent or an operator can read.
    const pairingHash = createHash("sha256").update(pairingCode).digest("hex");
    const credentialHash = createHash("sha256").update(credential).digest("hex");
    const secrets = { pairingCode, credential, pairingHash, credentialHash };
    const surfaces = { logs: logLines.join("\n"), transcript: transcript.join("\n"), ...artifacts };
    for (const [surface, body] of Object.entries(surfaces)) {
      for (const [name, secret] of Object.entries(secrets)) {
        expect(body.includes(secret), `${name} appeared in ${surface}`).toBe(false);
      }
    }
    expect(logLines.length, "the Fastify logger recorded nothing, so the redaction check proves nothing").toBeGreaterThan(0);
    expect(surfaces.transcript).toContain(task.id);
  } finally { session?.close(); await fixture.close(); }
});
