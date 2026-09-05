import { expect, test } from "vitest";
import { nativeApp } from "./helpers/native-app.js";

test("templates use native profile defaults and support explicit reset", async () => {
  const f = await nativeApp();
  try {
    const url = `/api/projects/${f.project.id}/task-templates`;
    const payload = { name: "Review a change", description: "Check the result", rootProfileId: f.project.rootProfileId, workerProfileId: f.project.workerProfileId, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" };
    const created = await f.app.inject({ method: "POST", url, headers: f.headers, payload });
    expect(created.statusCode, created.body).toBe(201);
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload })).statusCode).toBe(409);
    const id = created.json().id;
    const updated = await f.app.inject({ method: "PATCH", url: `/api/task-templates/${id}`, headers: f.headers, payload: { rootProfileId: null } });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).not.toHaveProperty("rootProfileId");
    expect(updated.json().workerProfileId).toBe(f.project.workerProfileId);
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload: { ...payload, roleAgents: {} } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "DELETE", url: `/api/task-templates/${id}`, headers: f.headers })).statusCode).toBe(204);
    expect((await f.app.inject({ method: "GET", url, headers: f.headers })).json().templates).toEqual([]);
  } finally { await f.close(); }
});
