import { createHash } from "node:crypto";

import { expect, test } from "vitest";

import { nativeBrowser } from "./helpers/native-browser.js";
import { freePort } from "./webauthn-helpers.js";

test("OAuth consent grants one selected project and returns the client state and code", async () => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const value = await nativeBrowser(1100, "127.0.0.1", origin);
  try {
    const registered = await value.app.inject({ method: "POST", url: "/oauth/register", payload: {
      client_name: "Claude browser test",
      redirect_uris: [`${origin}/oauth-test-callback`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    } });
    expect(registered.statusCode).toBe(201);
    const clientId = (registered.json() as { client_id: string }).client_id;
    const verifier = "v".repeat(43);
    const state = "browser-state";
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${origin}/oauth-test-callback`,
      response_type: "code",
      state,
      scope: "forge:mcp",
      resource: `${origin}/mcp`,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });

    await value.page.goto(`${origin}/oauth/authorize?${query}`);
    await value.page.getByRole("heading", { name: "Approve Claude browser test?" }).waitFor();
    const approve = value.page.getByRole("button", { name: "Approve", exact: true });
    expect(await approve.isDisabled()).toBe(true);
    await value.page.getByText(value.project.name, { exact: true }).click();
    expect(await approve.isEnabled()).toBe(true);
    await approve.click();
    await value.page.waitForURL(url => url.pathname === "/oauth-test-callback");

    const callback = new URL(value.page.url());
    expect(callback.searchParams.get("state")).toBe(state);
    expect(callback.searchParams.get("iss")).toBe(origin);
    expect(callback.searchParams.get("code")).toMatch(/^foc_/);
    expect(value.database.authQuery(db => (db.prepare("SELECT COUNT(*) AS count FROM forge_external_agent_project_grants WHERE project_id = ?").get(value.project.id) as { count: number }).count)).toBe(1);
    expect(value.errors).toEqual([]);
  } finally {
    await value.close();
  }
});
