import { expect, test } from "vitest";
import { nativeApp } from "./helpers/native-app.js";
import { stat } from "node:fs/promises";
import { ProviderInstanceService } from "../src/profiles/provider-instances.js";
import { TaskProfileSchema } from "../src/tasks/control.js";

test("fresh installs have one Coordinator and one Worker with Codex CLI settings", async () => {
  const f = await nativeApp();
  try {
    expect(f.profiles.list(f.userId)).toMatchObject([
      { id: "profile_native_root", role: "root", provider: "codex", model: "gpt-5.6-sol", serviceTier: "default" },
      { id: "profile_native_worker", role: "worker", provider: "codex", model: "gpt-5.6-luna", reasoningLevel: "max", serviceTier: "priority" },
    ]);
    expect(f.database.authQuery(db => db.prepare("PRAGMA foreign_key_check").all())).toEqual([]);
    expect(f.database.authQuery(db => db.prepare("SELECT name FROM sqlite_master WHERE name IN ('forge_models', 'forge_issue_projections', 'forge_engine_commands', 'worker_registrations')").all())).toEqual([]);
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
    expect(copy).toMatchObject({ name: "Root (copy)", role: "root" });
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
    expect(f.database.authQuery(db => db.prepare("SELECT 1 FROM forge_provider_instances WHERE id = ?").get(instance.id))).toBeUndefined();
  } finally { await f.close(); }
});

test("provider instance migration creates the table and profile reference", async () => {
  const f = await nativeApp();
  try {
    expect(f.database.authQuery(db => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'forge_provider_instances'").get())).toBeTruthy();
    expect(f.database.authQuery(db => db.prepare("PRAGMA table_info('forge_profiles')").all())).toEqual(expect.arrayContaining([expect.objectContaining({ name: "provider_instance_id" })]));
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
