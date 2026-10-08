import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

import { SystemHealthProvider } from "../src/frontend/components/app/system-health.js";
import { DesktopHostBar } from "../src/frontend/shell/desktop-host-bar.js";

afterEach(() => { vi.unstubAllGlobals(); });

test("the host bar appears only in the desktop app and uses the host health", () => {
  vi.stubGlobal("window", { location: { host: "127.0.0.1:4111", hostname: "127.0.0.1" } });
  const render = () => renderToStaticMarkup(<SystemHealthProvider initialSnapshot={{
    generatedAt: "2026-09-27T00:00:00Z", reachableAddress: "http://127.0.0.1:4111", ready: true,
    checks: [{ id: "git", label: "Git", status: "healthy", summary: "Git answered", details: {} }],
  }}><DesktopHostBar /></SystemHealthProvider>);
  expect(render()).toBe("");
  vi.stubGlobal("window", { location: { host: "127.0.0.1:4111", hostname: "127.0.0.1" }, suplexApp: { openHostPicker: async () => undefined } });
  expect(render()).toContain("This Mac");
  expect(render()).toContain("Ready");
  expect(render()).not.toContain("Installed version");
  vi.stubGlobal("window", { location: { host: "127.0.0.1:4111", hostname: "127.0.0.1" }, suplexApp: { version: "1.6.1", openHostPicker: async () => undefined } });
  expect(render()).toContain("Installed version 1.6.1");
  vi.stubGlobal("window", { location: { host: "studio.tail1234.ts.net", hostname: "studio.tail1234.ts.net" }, suplexMobile: { openHostPicker: async () => undefined } });
  expect(render()).toContain("studio.tail1234.ts.net");
  expect(render()).not.toContain("Ready");
});

test("the titlebar inset and drag regions use the desktop class and Tauri drag attribute, not Chromium-only CSS", () => {
  const styles = readFileSync(new URL("../src/frontend/styles.css", import.meta.url), "utf8");
  expect(styles).not.toMatch(/app-region|titlebar-area/);
  expect(styles).toContain(".suplex-desktop { --titlebar-height: 2.375rem; --titlebar-x: 5rem; }");
  expect(styles).toContain(".titlebar-inset { padding-left: var(--titlebar-x, 0px); }");
  for (const file of ["shell/application-frame.tsx", "shell/navigation.tsx", "features/settings/settings-layout.tsx", "features/onboarding/onboarding-wizard.tsx"]) {
    expect(readFileSync(new URL(`../src/frontend/${file}`, import.meta.url), "utf8"), file).toContain('data-tauri-drag-region="deep"');
  }
});
