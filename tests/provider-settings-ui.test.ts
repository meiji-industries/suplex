import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import { CompanyProvider } from "../src/frontend/components/app/company-context.js";
import { StatusLight } from "../src/frontend/components/app/status-light.js";
import { ThemeProvider } from "../src/frontend/components/app/theme.js";
import { Spinner } from "../src/frontend/components/ui/spinner.js";
import { ProviderSettingsView } from "../src/frontend/views/provider-settings.js";

function renderProviderSettings(): string {
  vi.stubGlobal("window", {
    localStorage: { getItem: () => null },
    matchMedia: () => ({ matches: false }),
  });
  try {
    return renderToStaticMarkup(createElement(ThemeProvider, null, createElement(CompanyProvider, null, createElement(ProviderSettingsView))));
  } finally {
    vi.unstubAllGlobals();
  }
}

test("provider settings identifies native configuration without claiming authentication", () => {
  const html = renderProviderSettings();
  expect(html).toContain('aria-label="Providers"');
  expect(html).toContain("Configured in OpenCode");
  expect(html).toContain("Provider");
  expect(html).toContain("Configuration");
  expect(html).toContain("Model request");
  expect(html).toContain("opencode auth login");
  expect(html).toContain('aria-label="Use dark theme"');
  expect(html).not.toContain('type="password"');
});

test("the shared status light has an accessible state label", () => {
  const html = renderToStaticMarkup(createElement(StatusLight, { level: "green", label: "OpenRouter: ready" }));
  expect(html).toContain('aria-label="OpenRouter: ready"');
  expect(html).toContain("animate-ping");
});

test("the shared spinner exposes its default accessible loading state", () => {
  const html = renderToStaticMarkup(createElement(Spinner));
  expect(html).toContain('data-slot="spinner"');
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-label="Loading"');
  expect(html).toContain("size-4 animate-spin");
});

test("provider settings shows a spinner while configuration loads", () => {
  const html = renderProviderSettings();
  expect(html).toContain("Forge checks OpenCode configuration.");
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('data-slot="spinner"');
  expect(html).toContain("size-4 animate-spin");
});
