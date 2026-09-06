import { expect, test } from "vitest";
import { nativeApp } from "./helpers/native-app.js";

test("fresh installs have one Coordinator and one Worker with OpenCode settings", async () => {
  const f = await nativeApp();
  try {
    expect(f.profiles.list(f.userId)).toMatchObject([
      { id: "profile_native_root", role: "root", provider: "openai", serviceTier: "default" },
      { id: "profile_native_worker", role: "worker", provider: "openai", reasoningLevel: "max", serviceTier: "priority" },
    ]);
    expect(f.database.authQuery(db => db.prepare("PRAGMA foreign_key_check").all())).toEqual([]);
    expect(f.database.authQuery(db => db.prepare("SELECT name FROM sqlite_master WHERE name IN ('forge_models', 'forge_issue_projections', 'forge_engine_commands', 'worker_registrations')").all())).toEqual([]);
  } finally { await f.close(); }
});

test("agent API saves OpenCode provider settings and rejects old harness fields", async () => {
  const f = await nativeApp();
  try {
    const url = "/api/admin/profiles/profile_native_worker";
    const saved = await f.app.inject({ method: "PATCH", url, headers: f.headers, payload: { provider: "opencode", model: "gpt-5.6-luna", serviceTier: "priority" } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ role: "worker", provider: "opencode", model: "gpt-5.6-luna" });
    for (const payload of [{ provider: "codex" }, { capacity: 2 }, { role: "builder" }, { servicePriority: "fast" }]) {
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
