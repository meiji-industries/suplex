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

test("declared variables match the placeholders each template actually uses", () => {
  for (const template of loadPromptCatalog().values()) {
    const used = new Set([...`${template.guidance}\n${template.contract ?? ""}`.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]));
    expect([...template.variables].sort(), template.id).toEqual([...used].sort());
  }
});

test("CI repair prompts keep deterministic base failures on the task branch", () => {
  const prompts = loadDefaultPrompts();

  expect(prompts.get("lead/ci-repair.md")).toContain("including one that reproduces on the base");
  expect(prompts.get("lead/ci-repair.md")).toContain("Do not defer a deterministic repair to main or another branch.");
  expect(prompts.get("developer/ci-repair.md")).toContain("Do not defer a repair to main or another branch merely because the failure also reproduces on the base.");
  expect(prompts.get("developer/ci-repair.md")).toContain("export PATH=\"$(dirname \"$(mise which node)\"):$PATH\"");
});
