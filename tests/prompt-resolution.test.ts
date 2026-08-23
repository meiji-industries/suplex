import { expect, test } from "vitest";

import type { PromptTemplate } from "../src/prompts.js";
import { resolvePrompt, validateOverrideContent } from "../src/prompt-resolution.js";

const template: PromptTemplate = { id: "lead/plan", path: "lead/plan.md", category: "agent", archetype: "planner", title: "Plan", editable: true, variables: ["title"], renamedFrom: [], guidance: "system {{title}}", contract: "must remain", guidanceSha256: "system-sha" };
const override = (mode: "inherit" | "append" | "replace", content: string, revision = 1) => ({ id: `override-${revision}`, templateId: template.id, mode, content, baseTemplateSha256: "system-sha", currentRevision: revision });

test("resolves layers in order and always retains the contract", () => {
  const resolved = resolvePrompt(template, override("append", "global"), override("replace", "project"));
  expect(resolved.text).toBe("project\n---contract---\nmust remain");
  expect(resolved.steps.map(({ layer, mode }) => [layer, mode])).toEqual([["system", "inherit"], ["global", "append"], ["project", "replace"]]);
});

test("marks stale replacements and rejects unsafe override content", () => {
  expect(resolvePrompt(template, { ...override("replace", "global"), baseTemplateSha256: "old" }).staleReplace).toBe(true);
  expect(validateOverrideContent(template, "{{unknown}} {{ bad }} ---contract---").map(({ code }) => code)).toEqual(expect.arrayContaining(["contract_separator", "unknown_variable", "malformed_placeholder"]));
});
