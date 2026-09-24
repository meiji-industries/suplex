import { expect, test } from "vitest";
import { nativeApp } from "./helpers/native-app.js";
import { stat } from "node:fs/promises";
import { ProviderInstanceService } from "../src/profiles/provider-instances.js";
import { TaskProfileSchema } from "../src/tasks/control.js";

// The list sorts by name. These checks read the Coordinator and then the Worker.
const byId = <T extends { id: string }>(profiles: T[]): T[] => [...profiles].sort((a, b) => a.id.localeCompare(b.id));

test("fresh installs have one Coordinator and one Worker with Codex CLI settings", async () => {
  const f = await nativeApp();
  try {
    expect(byId(f.profiles.list(f.userId))).toMatchObject([
      { id: "profile_native_root", role: "root", provider: "codex", model: "gpt-5.6-sol", serviceTier: "default" },
      { id: "profile_native_worker", role: "worker", provider: "codex", model: "gpt-5.6-luna", reasoningLevel: "max", serviceTier: "priority" },
    ]);
    expect(f.database.authQuery(db => db.prepare("PRAGMA foreign_key_check").all())).toEqual([]);
    expect(f.database.authQuery(db => db.prepare("SELECT name FROM sqlite_master WHERE name IN ('suplex_models', 'suplex_issue_projections', 'suplex_engine_commands', 'worker_registrations')").all())).toEqual([]);
  } finally { await f.close(); }
});

test("fresh installs point the default agents at the best installed CLI until an admin changes them", async () => {
  const f = await nativeApp();
  const settings = () => byId(f.profiles.list(f.userId)).map(({ provider, model, reasoningLevel, serviceTier }) => ({ provider, model, reasoningLevel, serviceTier }));
  const only = (...providers: string[]) => async (provider: string) => providers.includes(provider);
  try {
    await f.profiles.chooseDefaults(f.userId, only());
    expect(settings()).toEqual([
      { provider: "codex", model: "gpt-5.6-sol", reasoningLevel: "medium", serviceTier: "default" },
      { provider: "codex", model: "gpt-5.6-luna", reasoningLevel: "max", serviceTier: "priority" },
    ]);
    await f.profiles.chooseDefaults(f.userId, only("devin", "codex"));
    expect(settings()).toEqual([
      { provider: "codex", model: "gpt-6-astra", reasoningLevel: "medium", serviceTier: "default" },
      { provider: "codex", model: "gpt-6-sol", reasoningLevel: "medium", serviceTier: "default" },
    ]);
    await f.profiles.chooseDefaults(f.userId, only("devin"));
    expect(settings().map(agent => [agent.model, agent.reasoningLevel])).toEqual([["swe-2", "high"], ["swe-2", "medium"]]);
    // Installing Claude Code during onboarding still moves untouched defaults.
    await f.profiles.chooseDefaults(f.userId, only("claude-code", "codex"));
    expect(settings()).toEqual([
      { provider: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", serviceTier: "default" },
      { provider: "claude-code", model: "claude-opus-5-5", reasoningLevel: "medium", serviceTier: "default" },
    ]);
    f.profiles.update(f.userId, "profile_native_worker", { reasoningLevel: "high" });
    await f.profiles.chooseDefaults(f.userId, only("codex"));
    expect(settings().map(agent => [agent.model, agent.reasoningLevel])).toEqual([["claude-opus-5-5", "high"], ["claude-opus-5-5", "high"]]);
  } finally { await f.close(); }
});

test("installs with no tasks move from the previous Claude Code defaults, and installs with tasks keep them", async () => {
  const f = await nativeApp();
  const settings = () => byId(f.profiles.list(f.userId)).map(({ provider, model, reasoningLevel, serviceTier }) => ({ provider, model, reasoningLevel, serviceTier }));
  const only = (...providers: string[]) => async (provider: string) => providers.includes(provider);
  const previous = [
    { provider: "claude-code", model: "claude-fable-5-1", reasoningLevel: "medium", serviceTier: "default" },
    { provider: "claude-code", model: "claude-opus-5-5", reasoningLevel: "medium", serviceTier: "default" },
  ] as const;
  const holdPrevious = () => {
    f.profiles.update(f.userId, "profile_native_root", previous[0]);
    f.profiles.update(f.userId, "profile_native_worker", previous[1]);
  };
  try {
    holdPrevious();
    await f.profiles.chooseDefaults(f.userId, only("claude-code"));
    expect(settings().map(agent => [agent.model, agent.reasoningLevel])).toEqual([["claude-opus-5-5", "high"], ["claude-opus-5-5", "medium"]]);
    // The previous defaults are never chosen again, so another installed CLI replaces them.
    holdPrevious();
    await f.profiles.chooseDefaults(f.userId, only("codex"));
    expect(settings().map(agent => [agent.provider, agent.model])).toEqual([["codex", "gpt-6-astra"], ["codex", "gpt-6-sol"]]);
    holdPrevious();
    await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Ran", description: "Keep settings", idempotencyKey: "previous-defaults-task", startImmediately: false });
    await f.profiles.chooseDefaults(f.userId, only("claude-code"));
    expect(settings()).toEqual(previous);
  } finally { await f.close(); }
});

test("agent API saves harness providers and rejects vendor providers and old fields", async () => {
  const f = await nativeApp();
  try {
    const url = "/api/admin/profiles/profile_native_worker";
    const saved = await f.app.inject({ method: "PATCH", url, headers: f.headers, payload: { provider: "opencode", model: "openai/gpt-5.6-luna", serviceTier: "priority" } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ role: "worker", provider: "opencode", model: "openai/gpt-5.6-luna" });
    for (const payload of [{ provider: "openai" }, { capacity: 2 }, { role: "builder" }, { servicePriority: "fast" }]) {
      expect((await f.app.inject({ method: "PATCH", url, headers: f.headers, payload })).statusCode).toBe(400);
    }
    expect((await f.app.inject({ method: "GET", url: "/api/profiles", headers: f.headers })).json().profiles).toHaveLength(2);
  } finally { await f.close(); }
});

test("project defaults retain their role and cannot be archived", async () => {
  const f = await nativeApp();
  try {
    expect(() => f.profiles.update(f.userId, f.project.rootProfileId, { role: "worker" })).toThrow("Select another project default");
    expect(() => f.profiles.update(f.userId, f.project.rootProfileId, { archived: true })).toThrow("Select another project default");
    const copy = f.profiles.duplicate(f.userId, f.project.rootProfileId);
    expect(copy).toMatchObject({ name: "Smart Coordinator (copy)", role: "root" });
    f.profiles.update(f.userId, copy.id, { archived: true });
    expect(f.profiles.list(f.userId)).toHaveLength(2);
    expect(f.profiles.list(f.userId, true)).toHaveLength(3);
  } finally { await f.close(); }
});

test("provider instances allocate private directories and protect profile references", async () => {
  const f = await nativeApp();
  try {
    const instances = new ProviderInstanceService(f.database, f.auth);
    await expect(instances.create(f.userId, { provider: "opencode", label: "No" })).rejects.toMatchObject({ statusCode: 422 });
    const instance = await instances.create(f.userId, { provider: "claude-code", label: "Claude" });
    expect((await stat(instance.homeDirectory)).mode & 0o777).toBe(0o700);
    expect(() => f.profiles.update(f.userId, "profile_native_root", { providerInstanceId: "missing" })).toThrow("does not exist");
    expect(() => f.profiles.update(f.userId, "profile_native_root", { providerInstanceId: instance.id })).toThrow("different provider");
    f.profiles.update(f.userId, "profile_native_root", { provider: "claude-code", providerInstanceId: instance.id });
    await expect(instances.delete(f.userId, instance.id)).rejects.toMatchObject({ statusCode: 409 });
    f.profiles.update(f.userId, "profile_native_root", { providerInstanceId: null });
    await instances.delete(f.userId, instance.id);
    expect(f.database.authQuery(db => db.prepare("SELECT 1 FROM suplex_provider_instances WHERE id = ?").get(instance.id))).toBeUndefined();
  } finally { await f.close(); }
});

test("provider instances protect project policy references until the policy clears", async () => {
  const f = await nativeApp();
  try {
    const instances = new ProviderInstanceService(f.database, f.auth);
    const instance = await instances.create(f.userId, { provider: "claude-code", label: "acmelaude" });
    const defaultProviders = f.profiles.list(f.userId).filter((profile) => profile.id === f.project.rootProfileId || profile.id === f.project.workerProfileId).map((profile) => profile.provider);
    await f.projects.patchProject(f.userId, f.project.id, { providerPolicy: { allowedProviders: [...new Set([...defaultProviders, instance.provider])], allowedInstanceIds: [instance.id] } });

    await expect(instances.delete(f.userId, instance.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(f.projects.getProject(f.userId, f.project.id).providerPolicy?.allowedInstanceIds).toContain(instance.id);

    await f.projects.patchProject(f.userId, f.project.id, { providerPolicy: null });
    await instances.delete(f.userId, instance.id);
    expect(f.database.authQuery((db) => db.prepare("SELECT 1 FROM suplex_provider_instances WHERE id = ?").get(instance.id))).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("provider instance migration creates the table and profile reference", async () => {
  const f = await nativeApp();
  try {
    expect(f.database.authQuery(db => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'suplex_provider_instances'").get())).toBeTruthy();
    expect(f.database.authQuery(db => db.prepare("PRAGMA table_info('suplex_profiles')").all())).toEqual(expect.arrayContaining([expect.objectContaining({ name: "provider_instance_id" })]));
  } finally { await f.close(); }
});

test("task profile snapshots resolve the provider instance home directory", async () => {
  const f = await nativeApp();
  try {
    const instance = await new ProviderInstanceService(f.database, f.auth).create(f.userId, { provider: "claude-code", label: "Snapshot" });
    f.profiles.update(f.userId, "profile_native_root", { provider: "claude-code", providerInstanceId: instance.id });
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Snapshot", description: "Capture profile", idempotencyKey: "provider-instance-snapshot", startImmediately: false });
    expect(task.rootProfile.instanceHomeDirectory).toBe(instance.homeDirectory);
    expect(task.workerProfile.instanceHomeDirectory).toBeNull();
  } finally { await f.close(); }
});

test("stored profile snapshots upgrade an OpenCode vendor provider to a qualified model", () => {
  expect(TaskProfileSchema.parse({ profileId: "profile", provider: "openai", model: "gpt-5.6-sol", reasoningLevel: "medium", serviceTier: "default" }))
    .toMatchObject({ provider: "opencode", model: "openai/gpt-5.6-sol" });
  expect(TaskProfileSchema.parse({ profileId: "profile", provider: "codex", model: "gpt-5.6-sol", reasoningLevel: "medium", serviceTier: "default" }))
    .toMatchObject({ provider: "codex", model: "gpt-5.6-sol" });
});

const agent = (f: Awaited<ReturnType<typeof nativeApp>>, name: string, role: "root" | "worker") =>
  f.profiles.create(f.userId, { name, role, avatarSeed: "b".repeat(32), provider: "codex", model: "gpt-5.6-sol", reasoningLevel: "medium", serviceTier: "default" });

test("admins delete an agent with its avatar and audit event", async () => {
  const f = await nativeApp();
  try {
    const spare = agent(f, "Spare", "worker");
    f.database.authTransaction(db => db.prepare("INSERT INTO suplex_avatars (owner_id, shape, updated_at) VALUES (?, 'circle', ?)").run(spare.id, new Date().toISOString()));
    const url = `/api/admin/profiles/${spare.id}`;
    const deleted = await f.app.inject({ method: "DELETE", url, headers: f.headers });
    expect(deleted.statusCode, deleted.body).toBe(204);
    const listed = (await f.app.inject({ method: "GET", url: "/api/profiles?includeArchived=true", headers: f.headers })).json().profiles as Array<{ id: string }>;
    expect(listed.map(profile => profile.id)).not.toContain(spare.id);
    expect(f.database.authQuery(db => db.prepare("SELECT 1 FROM suplex_avatars WHERE owner_id = ?").get(spare.id))).toBeUndefined();
    expect(f.auth.listAuditEvents(f.userId)).toEqual(expect.arrayContaining([expect.objectContaining({ action: "agent_profile_deleted", metadata: { profileId: spare.id } })]));
    expect((await f.app.inject({ method: "DELETE", url, headers: f.headers })).statusCode).toBe(404);
    const archived = agent(f, "Archived", "worker");
    f.profiles.update(f.userId, archived.id, { archived: true });
    f.database.authTransaction(db => db.prepare("UPDATE suplex_users SET role = 'member' WHERE id = ?").run(f.userId));
    expect((await f.app.inject({ method: "DELETE", url: `/api/admin/profiles/${archived.id}`, headers: f.headers })).statusCode).toBe(403);
    f.database.authTransaction(db => db.prepare("UPDATE suplex_users SET role = 'admin' WHERE id = ?").run(f.userId));
    expect((await f.app.inject({ method: "DELETE", url: `/api/admin/profiles/${archived.id}`, headers: f.headers })).statusCode).toBe(204);
    expect(f.database.authQuery(db => db.prepare("PRAGMA foreign_key_check").all())).toEqual([]);
  } finally { await f.close(); }
});

test("agent delete refuses project, workflow, and template defaults and changes nothing", async () => {
  const f = await nativeApp();
  try {
    const remove = (id: string) => f.app.inject({ method: "DELETE", url: `/api/admin/profiles/${id}`, headers: f.headers });
    const project = await remove(f.project.rootProfileId);
    expect(project.statusCode).toBe(409);
    expect(project.json().error).toBe("Select another agent for the projects that use this agent before you delete it");

    const worker = agent(f, "Workflow worker", "worker");
    const workflow = f.workflows.create(f.userId, { name: "Uses worker", description: "", engine: "standard", workerProfileId: worker.id, deliveryTarget: "pull_request_draft" });
    expect((await remove(worker.id)).json().error).toContain("the workflows that");
    f.workflows.update(f.userId, workflow.id, { workerProfileId: null });

    const advisor = agent(f, "Template reviewer", "root");
    f.templates.create(f.userId, f.project.id, { name: "Reviewed", description: "Review", workflow: "independent_review", advisorProfileIds: { reviewer: advisor.id } });
    const template = await remove(advisor.id);
    expect(template.statusCode).toBe(409);
    expect(template.json().error).toContain("the task templates that");

    expect(f.profiles.list(f.userId).map(profile => profile.id)).toEqual(expect.arrayContaining([f.project.rootProfileId, advisor.id]));
    expect((await remove(worker.id)).statusCode).toBe(204);
  } finally { await f.close(); }
});

test("agent delete prunes project allowlists and keeps tasks that used the agent readable", async () => {
  const f = await nativeApp();
  try {
    const root = agent(f, "Second root", "root");
    const worker = agent(f, "Second worker", "worker");
    const policy = f.projects.getProject(f.userId, f.project.id).agentTaskPolicy!;
    await f.projects.patchProject(f.userId, f.project.id, { agentTaskPolicy: { ...policy, rootProfileIds: [...policy.rootProfileIds, root.id], workerProfileIds: [...policy.workerProfileIds, worker.id], advisorProfileIds: { ...policy.advisorProfileIds, reviewer: [root.id] } } });
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Uses agents", description: "Keep", idempotencyKey: "deleted-agent-task", rootProfileId: root.id, workerProfileId: worker.id, startImmediately: false });
    const before = f.database.authQuery(db => db.prepare("SELECT * FROM suplex_tasks WHERE id = ?").get(task.id));

    for (const id of [root.id, worker.id]) expect((await f.app.inject({ method: "DELETE", url: `/api/admin/profiles/${id}`, headers: f.headers })).statusCode).toBe(204);

    const pruned = f.projects.getProject(f.userId, f.project.id).agentTaskPolicy!;
    expect(pruned).toMatchObject({ rootProfileIds: policy.rootProfileIds, workerProfileIds: policy.workerProfileIds, advisorProfileIds: { reviewer: [] } });
    await f.projects.patchProject(f.userId, f.project.id, { agentTaskPolicy: pruned });
    expect(f.database.authQuery(db => db.prepare("SELECT * FROM suplex_tasks WHERE id = ?").get(task.id))).toEqual(before);
    const read = await f.app.inject({ method: "GET", url: `/api/tasks/${task.id}`, headers: f.headers });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ rootProfile: { profileId: root.id }, workerProfile: { profileId: worker.id } });
    expect(f.database.authQuery(db => db.prepare("PRAGMA foreign_key_check").all())).toEqual([]);
  } finally { await f.close(); }
});
