import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

import { SystemHealthProvider } from "../src/frontend/components/app/system-health.js";
import { DesktopHostBar } from "../src/frontend/shell/desktop-host-bar.js";

afterEach(() => { vi.unstubAllGlobals(); });

test("the host bar appears only in Electron and uses the host health", () => {
  vi.stubGlobal("window", { location: { host: "127.0.0.1:4111", hostname: "127.0.0.1" } });
  const render = () => renderToStaticMarkup(<SystemHealthProvider initialSnapshot={{
    generatedAt: "2026-09-27T00:00:00Z", reachableAddress: "http://127.0.0.1:4111", ready: true,
    checks: [{ id: "git", label: "Git", status: "healthy", summary: "Git answered", details: {} }],
  }}><DesktopHostBar /></SystemHealthProvider>);
  expect(render()).toBe("");
  vi.stubGlobal("window", { location: { host: "127.0.0.1:4111", hostname: "127.0.0.1" }, suplexApp: { openHostPicker: async () => undefined } });
  expect(render()).toContain("This Mac");
  expect(render()).toContain("Ready");
});
