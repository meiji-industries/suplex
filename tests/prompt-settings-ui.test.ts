import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { CompanyProvider } from "../src/frontend/components/app/company-context.js";
import { SettingsTableCell, SettingsTableRow } from "../src/frontend/components/app/settings-table.js";
import { PromptSettings } from "../src/frontend/views/prompt-settings.js";

test("renders the dense global prompt settings surface", () => {
  const html = renderToStaticMarkup(createElement(CompanyProvider, null, createElement(PromptSettings, { scope: "global" })));
  expect(html).toContain("Prompts");
  expect(html).toContain("Search prompts");
  expect(html).toContain("Agent prompts");
  expect(html).toContain("Shared prompts");
  expect(html).toContain("No overrides. Everything uses system defaults.");
});

test("users and prompt rows begin with the shared settings-table gutter", () => {
  const usersHtml = renderToStaticMarkup(createElement("table", null, createElement("tbody", null, createElement(SettingsTableRow, null, createElement(SettingsTableCell, null, "Example user")))));
  const promptsHtml = renderToStaticMarkup(createElement("table", null, createElement("tbody", null, createElement(SettingsTableRow, null, createElement(SettingsTableCell, null, "Example prompt")))));

  expect(usersHtml).toContain('<td class="align-middle p-0"></td><td class="px-1.5 align-middle">Example user</td>');
  expect(promptsHtml).toContain('<td class="align-middle p-0"></td><td class="px-1.5 align-middle">Example prompt</td>');
});
