import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { CompanyProvider } from "../src/frontend/components/app/company-context.js";
import { StatusLight } from "../src/frontend/components/app/status-light.js";
import { ProviderSettingsView } from "../src/frontend/views/provider-settings.js";

test("provider settings uses a dense provider table and password key control", () => {
  const html = renderToStaticMarkup(createElement(CompanyProvider, null, createElement(ProviderSettingsView)));
  expect(html).toContain('aria-label="Providers"');
  expect(html).toContain("Agent providers");
  expect(html).toContain("Provider");
  expect(html).toContain("Harness");
  expect(html).toContain("Status");
});

test("the shared status light has an accessible state label", () => {
  const html = renderToStaticMarkup(createElement(StatusLight, { level: "green", label: "OpenRouter: ready" }));
  expect(html).toContain('aria-label="OpenRouter: ready"');
  expect(html).toContain("animate-ping");
});
