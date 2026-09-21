import { expect, test } from "vitest";

import { DISCOVERY_ARTIFACT_PATHS } from "../src/http/routes/discovery.js";
import { nativeApp } from "./helpers/native-app.js";

const CONTENT_TYPES: Record<string, string> = {
  "/llms.txt": "text/plain; charset=utf-8",
  "/.well-known/forge/api-catalog.json": "application/json; charset=utf-8",
  "/.well-known/forge/agent-skills.json": "application/json; charset=utf-8",
};

/** A pairing code, a credential, or either one hashed must never reach a public artifact. */
export const SECRET_PATTERNS = [/fhp_[A-Za-z0-9_-]{10,}/, /fha_[A-Za-z0-9_-]{10,}/, /\b[0-9a-f]{64}\b/];

test("every public discovery artifact is served unauthenticated and carries no secret", async () => {
  const fixture = await nativeApp();
  try {
    const issued = fixture.externalAgent.create(fixture.userId, { name: "Discovery Bot", companyId: fixture.company.id, projectIds: [fixture.project.id] });
    const credential = fixture.externalAgent.exchange({ pairingCode: issued.pairingCode, profileId: "profile-bot" }).credential;
    await fixture.app.inject({ method: "POST", url: "/api/agent/tasks", headers: { Authorization: `Bearer ${credential}` }, payload: { projectId: fixture.project.id, title: "Confidential task title", idempotencyKey: "discovery-secret-1" } });

    for (const path of DISCOVERY_ARTIFACT_PATHS) {
      const response = await fixture.app.inject({ method: "GET", url: path });
      expect(response.statusCode, `${path}: ${response.body}`).toBe(200);
      expect(response.headers["content-type"], path).toBe(CONTENT_TYPES[path]);
      expect(response.body.length, path).toBeGreaterThan(0);
      for (const pattern of SECRET_PATTERNS) expect(response.body, `${path} matched ${pattern}`).not.toMatch(pattern);
      expect(response.body, path).not.toContain(issued.pairingCode);
      expect(response.body, path).not.toContain(credential);
      expect(response.body, path).not.toContain("Confidential task title");
      expect(response.body, path).not.toContain(fixture.company.id);
      expect(response.body, path).not.toContain(fixture.project.id);
    }
  } finally { await fixture.close(); }
});

test("the discovery artifacts state that pairing and a scoped credential are necessary", async () => {
  const fixture = await nativeApp();
  try {
    const overview = await fixture.app.inject({ method: "GET", url: "/llms.txt" });
    expect(overview.body).toContain("/api/agent/pairing/exchange");
    expect(overview.body).toContain("/api/agent/openapi.json");
    expect(overview.body).toContain("forge mcp");
    expect(overview.body).toMatch(/paired-agent bearer credential/);

    const catalog = (await fixture.app.inject({ method: "GET", url: "/.well-known/forge/api-catalog.json" })).json() as {
      authorization: string;
      discovery: Array<{ path: string; authentication: string }>;
      runtime: Array<{ path: string; authentication: string }>;
      pairing: Array<{ path: string }>;
    };
    expect(catalog.authorization).toMatch(/paired-agent bearer credential/);
    expect(catalog.runtime.every(entry => entry.authentication === "agent credential")).toBe(true);
    expect(catalog.runtime.map(entry => entry.path)).toContain("/api/agent/openapi.json");
    expect(catalog.pairing.map(entry => entry.path)).toEqual(["/api/agent/pairing/exchange"]);
    // Only the public artifacts themselves are reachable without a credential.
    expect(catalog.discovery.map(entry => entry.path).sort()).toEqual([...DISCOVERY_ARTIFACT_PATHS].sort());

    const skills = (await fixture.app.inject({ method: "GET", url: "/.well-known/forge/agent-skills.json" })).json() as {
      authorization: string;
      skills: Array<{ name: string; instructions: string; clients: Array<{ transport: string; documentation: string }> }>;
    };
    expect(skills.authorization).toMatch(/paired-agent bearer credential/);
    expect(skills.skills.map(entry => entry.name)).toEqual(["forge"]);
    expect(skills.skills[0]!.clients.map(client => client.transport)).toEqual(["mcp-stdio", "http-bearer"]);
  } finally { await fixture.close(); }
});

test("the runtime routes the artifacts name stay behind the credential", async () => {
  const fixture = await nativeApp();
  try {
    for (const path of ["/api/agent/openapi.json", "/api/agent/capabilities", "/api/agent/me", "/api/agent/workflows?projectId=project", "/api/agent/templates?projectId=project", "/api/agent/tasks"]) {
      const response = await fixture.app.inject({ method: "GET", url: path });
      expect(response.statusCode, path).toBe(401);
      expect(response.json(), path).toEqual({ error: "Authentication failed", code: "credential_invalid" });
    }
  } finally { await fixture.close(); }
});
