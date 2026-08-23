import { expect, test } from "vitest";

import { loadDefaultPrompts, loadPromptCatalog } from "../src/prompts.js";

test("every default prompt is catalogued and the derived defaults are its guidance", () => {
  const catalog = loadPromptCatalog();
  const defaults = loadDefaultPrompts();
  expect([...defaults]).toHaveLength(15);
  for (const [path, text] of defaults) {
    const template = catalog.get(path.slice(0, -3));
    expect(template?.guidance).toBe(text);
    expect(template?.id).toBe(path.slice(0, -3));
  }
  expect(catalog.get("pull-request/body")?.editable).toBe(false);
});
