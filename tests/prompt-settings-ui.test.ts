import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { CompanyProvider } from "../src/frontend/components/app/company-context.js";
import { PromptSettings } from "../src/frontend/views/prompt-settings.js";

test("renders the dense global prompt settings surface", () => {
  const html = renderToStaticMarkup(createElement(CompanyProvider, null, createElement(PromptSettings, { scope: "global" })));
  expect(html).toContain("Prompts");
  expect(html).toContain("Search prompts");
  expect(html).toContain("Agent prompts");
  expect(html).toContain("Shared prompts");
  expect(html).toContain("No overrides. Everything uses system defaults.");
});
