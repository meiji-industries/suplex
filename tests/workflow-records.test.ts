import { expect, test } from "vitest";
import { nativeApp } from "./helpers/native-app.js";

test("fresh installs seed one workflow record per built-in engine", async () => {
  const f = await nativeApp();
  try {
    expect(f.workflows.list(f.userId).map(workflow => [workflow.id, workflow.engine, workflow.name])).toEqual([
      ["workflow_native_competing_plans", "competing_plans", "Combined planning"],
      ["workflow_native_direct_build", "direct_build", "Direct build"],
      ["workflow_native_refine_pull_request", "refine_pull_request", "Pull request repair"],
      ["workflow_native_independent_review", "independent_review", "Second opinion"],
      ["workflow_native_standard", "standard", "Standard"],
    ]);
  } finally { await f.close(); }
});

test("workflow API edits default agents, validates them against the engine, and archives", async () => {
  const f = await nativeApp();
  try {
    const url = "/api/admin/workflows/workflow_native_refine_pull_request";
    const saved = await f.app.inject({ method: "PATCH", url, headers: f.headers, payload: { rootProfileId: "profile_native_root", advisorProfileIds: { rater: "profile_native_root" }, description: "Fable rates and plans." } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ engine: "refine_pull_request", rootProfileId: "profile_native_root", advisorProfileIds: { rater: "profile_native_root" }, description: "Fable rates and plans." });
    for (const payload of [
      { advisorProfileIds: { reviewer: "profile_native_root" } },
      { rootProfileId: "profile_native_worker" },
      { workerProfileId: "profile_missing" },
      { deliveryTarget: "pull_request_draft" },
    ]) expect((await f.app.inject({ method: "PATCH", url, headers: f.headers, payload })).statusCode, JSON.stringify(payload)).toBe(422);
    expect((await f.app.inject({ method: "PATCH", url, headers: f.headers, payload: { name: "Standard" } })).statusCode).toBe(409);
    // A new engine drops Advisor choices it does not admit and clears a null setting.
    const switched = await f.app.inject({ method: "PATCH", url, headers: f.headers, payload: { engine: "independent_review", rootProfileId: null } });
    expect(switched.json()).toMatchObject({ engine: "independent_review", advisorProfileIds: {} });
    expect(switched.json()).not.toHaveProperty("rootProfileId");

    const created = await f.app.inject({ method: "POST", url: "/api/admin/workflows", headers: f.headers, payload: { name: "Fable repair", engine: "refine_pull_request", advisorProfileIds: { rater: "profile_native_root" }, visualEvidence: "capture" } });
    expect(created.statusCode, created.body).toBe(201);
    const duplicated = await f.app.inject({ method: "POST", url: `/api/admin/workflows/${created.json().id}/duplicate`, headers: f.headers });
    expect(duplicated.json()).toMatchObject({ name: "Fable repair (copy)", engine: "refine_pull_request", advisorProfileIds: { rater: "profile_native_root" } });
    const archived = await f.app.inject({ method: "PATCH", url: `/api/admin/workflows/${created.json().id}`, headers: f.headers, payload: { archived: true } });
    expect(archived.json().archivedAt).toEqual(expect.any(String));
    expect((await f.app.inject({ method: "GET", url: "/api/workflows", headers: f.headers })).json().workflows.map((workflow: { name: string }) => workflow.name)).not.toContain("Fable repair");
    expect((await f.app.inject({ method: "GET", url: "/api/workflows?includeArchived=true", headers: f.headers })).json().workflows).toHaveLength(7);
  } finally { await f.close(); }
});
