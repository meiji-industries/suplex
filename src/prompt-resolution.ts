import { createHash } from "node:crypto";

import { composePrompt, type PromptTemplate } from "./prompts.js";

export type OverrideMode = "inherit" | "append" | "replace";
export type PromptOverrideRow = { id: string; templateId: string; mode: OverrideMode; content: string; baseTemplateSha256: string; currentRevision: number };
type Layer = "system" | "global" | "project";
export type ProvenanceStep = { layer: Layer; mode: OverrideMode; revision?: number; overrideId?: string; sha256: string };
export type ResolvedPrompt = { templateId: string; text: string; guidance: string; sha256: string; steps: ProvenanceStep[]; staleReplace: boolean };

export function isVersionedPromptSet(value: unknown): value is { version: 2; prompts: Record<string, string> } {
  return typeof value === "object" && value !== null && "version" in value && value.version === 2 && "prompts" in value && typeof value.prompts === "object" && value.prompts !== null;
}

const contractSeparator = "\n---contract---\n";
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function guidance(text: string): string {
  return text.split(contractSeparator, 1)[0]!;
}

export function validateOverrideContent(template: PromptTemplate, content: string): Array<{ code: "unknown_variable" | "malformed_placeholder" | "contract_separator"; message: string }> {
  const findings: Array<{ code: "unknown_variable" | "malformed_placeholder" | "contract_separator"; message: string }> = [];
  if (content.includes("---contract---")) findings.push({ code: "contract_separator", message: "Overrides cannot inject a contract separator" });
  for (const placeholder of content.matchAll(/\{\{(.*?)\}\}/g)) {
    const name = placeholder[1]!;
    if (!/^\w+$/.test(name)) findings.push({ code: "malformed_placeholder", message: `Malformed placeholder: ${placeholder[0]}` });
    else if (!template.variables.includes(name)) findings.push({ code: "unknown_variable", message: `Unknown placeholder: ${placeholder[0]}` });
  }
  if (/\{\{(?!(?:\w+)\}\})/.test(content) || /(?<!\{\{\w*)\}\}/.test(content)) findings.push({ code: "malformed_placeholder", message: "Malformed placeholder" });
  return findings;
}

export function resolvePrompt(template: PromptTemplate, global?: PromptOverrideRow | null, project?: PromptOverrideRow | null): ResolvedPrompt {
  let text = template.contract ? `${template.guidance}${contractSeparator}${template.contract}` : template.guidance;
  const steps: ProvenanceStep[] = [{ layer: "system", mode: "inherit", sha256: sha256(template.guidance) }];
  let staleReplace = false;
  for (const [layer, override] of [["global", global], ["project", project]] as const) {
    if (!override || override.mode === "inherit") {
      steps.push({ layer, mode: "inherit", sha256: sha256(guidance(text)) });
      continue;
    }
    text = composePrompt(text, `---\nmode: ${override.mode}\n---\n${override.content}`);
    if (override.mode === "replace" && override.baseTemplateSha256 !== template.guidanceSha256) staleReplace = true;
    steps.push({ layer, mode: override.mode, revision: override.currentRevision, overrideId: override.id, sha256: sha256(guidance(text)) });
  }
  return { templateId: template.id, text, guidance: guidance(text), sha256: sha256(text), steps, staleReplace };
}

export function resolvePromptSet(catalog: ReadonlyMap<string, PromptTemplate>, overrides: { global: ReadonlyMap<string, PromptOverrideRow>; project: ReadonlyMap<string, PromptOverrideRow> }): Map<string, ResolvedPrompt> {
  return new Map([...catalog.values()].filter((template, index, templates) => templates.findIndex(({ id }) => id === template.id) === index).map((template) => [template.id, resolvePrompt(template, overrides.global.get(template.id), overrides.project.get(template.id))]));
}
