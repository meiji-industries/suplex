import { expect, test } from "vitest";

import { parseThemePreference, resolveTheme } from "../src/frontend/components/app/theme.js";
import { renderApplicationPage, renderHealthPage } from "../src/ui.js";
import type { HealthSnapshot } from "../src/health.js";

test("theme preferences parse external storage values and resolve system preference", () => {
  expect(parseThemePreference("light")).toBe("light");
  expect(parseThemePreference("dark")).toBe("dark");
  expect(parseThemePreference("system")).toBe("system");
  expect(parseThemePreference("unknown")).toBe("system");
  expect(parseThemePreference(null)).toBe("system");
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("light", true)).toBe("light");
  expect(resolveTheme("dark", false)).toBe("dark");
});

test("application and health pages apply the saved or system theme before frontend assets load", () => {
  const snapshot: HealthSnapshot = { generatedAt: "2026-09-05T00:00:00.000Z", reachableAddress: "http://forge.test", ready: true, checks: [] };
  for (const html of [renderApplicationPage("tasks"), renderHealthPage(snapshot)]) {
    const bootstrap = html.indexOf('localStorage.getItem("forge.theme")');
    expect(bootstrap).toBeGreaterThan(0);
    expect(bootstrap).toBeLessThan(html.indexOf("/assets/forge-ui.css"));
    expect(bootstrap).toBeLessThan(html.indexOf("/assets/forge-ui.js"));
    expect(html).toContain('const root = document.documentElement; root.classList.toggle("dark", dark)');
    expect(html).toContain('content = dark ? "#0a0a0a" : "#ffffff"');
    expect(html.match(/root\.classList\.toggle/g)).toHaveLength(1);
  }
});
