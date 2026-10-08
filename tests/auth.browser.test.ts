import { expect, test } from "vitest";
import { CompanyResponseSchema } from "../apps/web/contracts/common.js";
import { nativeBrowser } from "./helpers/native-browser.js";

test("loopback requests create and preserve an Operator session", async () => {
  const fixture = await nativeBrowser(1100);
  try {
    const { page, browser, base } = fixture;
    // This journey creates a second company, so its host needs confirmed Pro access.
    const checkedAt = new Date();
    fixture.database.prepare("INSERT INTO suplex_account (id, account_id, email, token, linked_at) VALUES ('host', 'account_browser', 'browser@example.invalid', ?, ?)")
      .run("p".repeat(43), checkedAt.toISOString());
    fixture.database.prepare("INSERT INTO suplex_plan (id, account_id, access_until, checked_at) VALUES ('host', 'account_browser', ?, ?)")
      .run(new Date(checkedAt.getTime() + 86_400_000).toISOString(), checkedAt.toISOString());
    await page.goto(`${base}/auth`);
    await page.waitForURL(`${base}/tasks`);
    const initialAuth = await page.evaluate(async () => (await fetch("/api/auth/me")).json() as Promise<{ user: { id: string; displayName: string; role: string } }>);
    expect(initialAuth).toMatchObject({ user: { displayName: "Operator", role: "admin" } });
    const context = page.context();
    const initialCookies = await context.cookies(base);
    expect(initialCookies.map(cookie => cookie.name)).toEqual(expect.arrayContaining(["sid_v1", "csrf_v1"]));
    const initialSession = initialCookies.find(cookie => cookie.name === "sid_v1")?.value;
    expect(initialSession).toBeDefined();
    await page.reload();
    const reloadedAuth = await page.evaluate(async () => (await fetch("/api/auth/me")).json() as Promise<{ user: { id: string; displayName: string; role: string } }>);
    expect(reloadedAuth).toMatchObject({ user: { displayName: "Operator", role: "admin" } });
    expect(reloadedAuth.user.id).toBe(initialAuth.user.id);
    expect((await context.cookies(base)).find(cookie => cookie.name === "sid_v1")?.value).toBe(initialSession);
    await page.goto(`${base}/admin`);
    await page.getByRole("heading", { name: "Users", exact: true, level: 2 }).waitFor();
    await page.getByRole("button", { name: "Switch company" }).click();
    await page.getByRole("menuitem", { name: /New company/ }).click();
    await page.getByLabel("Company name", { exact: true }).fill("Browser Company");
    const [createdResponse] = await Promise.all([
      page.waitForResponse(response => response.url() === `${base}/api/admin/companies` && response.request().method() === "POST"),
      page.getByRole("dialog", { name: "New company", exact: true }).getByRole("button", { name: "New company", exact: true }).click(),
    ]);
    expect(createdResponse.status()).toBe(201);
    const created = CompanyResponseSchema.parse(await createdResponse.json());
    expect(created.name).toBe("Browser Company");
    await page.waitForURL(url => url.pathname === `/companies/${encodeURIComponent(created.id)}/settings` && url.searchParams.get("company") === created.id);
    await page.getByRole("heading", { name: "Workspace", exact: true, level: 2 }).waitFor();
    expect(await page.getByLabel("Company name", { exact: true }).inputValue()).toBe("Browser Company");
    expect(browser.isConnected()).toBe(true);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});
