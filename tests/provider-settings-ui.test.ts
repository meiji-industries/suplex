import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { CompanyProvider } from "../src/frontend/components/app/company-context.js";
import { StatusLight } from "../src/frontend/components/app/status-light.js";
import { ProviderSettingsView } from "../src/frontend/views/provider-settings.js";

test("provider settings identifies native configuration without claiming authentication", () => {
  const html = renderToStaticMarkup(createElement(CompanyProvider, null, createElement(ProviderSettingsView)));
  expect(html).toContain('aria-label="Providers"');
  expect(html).toContain("Configured in OpenCode");
  expect(html).toContain("Provider");
  expect(html).toContain("Configuration");
  expect(html).toContain("Model request");
  expect(html).toContain("opencode auth login");
  expect(html).not.toContain('type="password"');
});

test("the shared status light has an accessible state label", () => {
  const html = renderToStaticMarkup(createElement(StatusLight, { level: "green", label: "OpenRouter: ready" }));
  expect(html).toContain('aria-label="OpenRouter: ready"');
  expect(html).toContain("animate-ping");
});
