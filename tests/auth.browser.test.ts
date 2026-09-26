import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

test("loopback requests create and preserve an Operator session", async () => {
  const fixture = await nativeBrowser(1100);
  try {
    const { page, browser, base } = fixture;
    await page.goto(`${base}/auth`);
    await page.locator("h1").filter({ hasText: "Tasks" }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/tasks");
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
    await page.getByRole("button", { name: "Switch company" }).click();
    await page.getByRole("menuitem", { name: /New company/ }).click();
    await page.getByLabel("Company name", { exact: true }).fill("Browser Company");
    await page.getByRole("dialog", { name: "New company", exact: true }).getByRole("button", { name: "New company", exact: true }).click();
    await page.getByRole("heading", { name: "Workspace", exact: true, level: 2 }).waitFor();
    expect(browser.isConnected()).toBe(true);
  } finally { await fixture.close(); }
});
