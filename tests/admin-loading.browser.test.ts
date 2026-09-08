import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

test("Companies keeps membership controls without waiting for model discovery", async () => {
  const value = await nativeBrowser();
  const { page, base, auth, userId } = value;
  const requests: string[] = [];
  let releaseModels: (() => void) | undefined;
  const models = new Promise<void>(resolve => { releaseModels = resolve; });
  try {
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/admin/") || path === "/api/profiles") requests.push(path);
    });
    await page.route("**/api/admin/models", async route => {
      await models;
      await route.fulfill({ status: 503, json: { error: "Model discovery unavailable" } });
    });
    const users = auth.listUsers(userId);
    const admin = users.find(user => user.id === userId);
    if (!admin) throw new Error("Missing test administrator");
    await page.route("**/api/admin/users", route => route.fulfill({ json: {
      users: [...users, { ...admin, id: "member-loading-test", role: "member", displayName: "Test Member", companyIds: [] }],
    } }));

    await page.goto(`${base}/admin/companies`);
    await page.getByRole("table", { name: "Companies", exact: true }).waitFor({ timeout: 2000 });
    expect(requests).toEqual(["/api/admin/users"]);
    await page.getByRole("button", { name: "Native actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Add Test Member", exact: true }).waitFor();
    await page.keyboard.press("Escape");

    await page.getByRole("link", { name: "Models", exact: true }).click();
    await expect.poll(() => requests.includes("/api/admin/models")).toBe(true);
    await page.getByLabel("Loading administration", { exact: true }).waitFor();
    requests.length = 0;
    await page.getByRole("link", { name: "Companies", exact: true }).click();
    await page.getByRole("table", { name: "Companies", exact: true }).waitFor({ timeout: 2000 });
    expect(requests).toEqual(["/api/admin/users"]);
    releaseModels?.();
    expect(value.errors).toEqual([]);
  } finally {
    releaseModels?.();
    await value.close();
  }
});

test("Admin sections fetch only the data their controls use", async () => {
  const value = await nativeBrowser();
  const { page, base, company } = value;
  const requests: string[] = [];
  try {
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/admin/") || path === "/api/profiles" || path.endsWith("/projects")) requests.push(path);
    });
    const sections = [
      { path: "/admin", table: "Users", endpoints: ["/api/admin/users", "/api/admin/credentials"] },
      { path: "/admin/invitations", table: "Invitations", endpoints: ["/api/admin/invitations"] },
      { path: "/admin/passkeys", table: "Passkeys", endpoints: ["/api/admin/users", "/api/admin/credentials"] },
      { path: "/admin/models", table: "Models", endpoints: ["/api/admin/models"] },
      { path: "/admin/agents", table: "Internal Agents", endpoints: ["/api/profiles", "/api/admin/hermes-agents", `/api/companies/${company.id}/projects`, "/api/admin/models"] },
    ];
    for (const section of sections) {
      requests.length = 0;
      await page.goto(`${base}${section.path}`);
      await page.getByRole("table", { name: section.table, exact: true }).waitFor();
      expect(requests.sort()).toEqual(section.endpoints.sort());
    }
    expect(value.errors).toEqual([]);
  } finally {
    await value.close();
  }
});
