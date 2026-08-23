import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";


export const PROMPT_PATHS = [
  "developer/execution.md", "developer/repair.md", "developer/ci-repair.md", "developer/merge-resolution.md", "developer/integrator.md",
  "lead/plan.md", "lead/review.md", "lead/consolidation.md", "lead/delivery-review.md", "lead/delivery-repair-plan.md", "lead/ci-repair.md", "lead/merge-conflict-plan.md", "lead/integrator.md",
  "pull-request/guidance.md", "pull-request/body.md",
] as const;
export type PromptPath = typeof PROMPT_PATHS[number];

const defaultsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
let defaults: Map<PromptPath, string> | undefined;
let catalog: Map<string, PromptTemplate> | undefined;

export type PromptTemplate = {
  id: string;
  path: PromptPath;
  category: "agent" | "shared";
  archetype: string;
  title: string;
  editable: boolean;
  variables: readonly string[];
  renamedFrom: readonly string[];
  guidance: string;
  contract: string | null;
  guidanceSha256: string;
};

const archetypes = new Set(["planner", "reviewer", "builder", "integrator", "task-framing", "repository-context", "output-format", "pull-request", "naming-routing"]);
const separator = "\n---contract---\n";

export function parsePromptTemplate(path: PromptPath, text: string): PromptTemplate {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error(`Prompt template is missing front matter: ${path}`);
  const values = Object.fromEntries((match[1] ?? "").split("\n").map((line) => {
    const index = line.indexOf(":");
    return [line.slice(0, index), line.slice(index + 1).trim()];
  }));
  const id = values.id;
  const category = values.category;
  const archetype = values.archetype;
  const title = values.title;
  const editable = values.editable;
  const list = (value: string | undefined) => (value?.match(/^\[(.*)\]$/)?.[1] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const variables = list(values.variables);
  const renamedFrom = list(values.renamed_from);
  if (!id || id !== path.slice(0, -3) || (category !== "agent" && category !== "shared") || !archetype || !archetypes.has(archetype) || !title || (editable !== "true" && editable !== "false") || variables.some((name) => !/^\w+$/.test(name))) throw new Error(`Invalid prompt template metadata: ${path}`);
  const body = text.slice(match[0]?.length ?? 0);
  const boundary = body.indexOf(separator);
  if (boundary < 0) throw new Error(`Prompt template is missing contract separator: ${path}`);
  const guidance = body.slice(0, boundary);
  const contract = body.slice(boundary + separator.length);
  return { id, path, category, archetype, title, editable: editable === "true", variables, renamedFrom, guidance, contract: contract || null, guidanceSha256: createHash("sha256").update(guidance).digest("hex") };
}

/** Legacy repository overrides; removed when database-backed layers land. */
export async function resolveProjectPrompts(repositoryPath: string, baseSha: string): Promise<Map<PromptPath, string>> {
  const { runCommand } = await import("./command-runner.js");
  const overrides = new Map<PromptPath, string>();
  await Promise.all(PROMPT_PATHS.map(async (path) => {
    const result = await runCommand({ taskId: null, stepId: null, command: "git", args: ["show", `${baseSha}:.forge/prompts/${path}`], cwd: repositoryPath, timeout: 30_000 });
    if (result.exitCode === 0 && !result.timedOut) overrides.set(path, result.stdout);
  }));
  return overrides;
}

export function loadPromptCatalog(): ReadonlyMap<string, PromptTemplate> {
  if (catalog) return catalog;
  const parsed = PROMPT_PATHS.map((path) => parsePromptTemplate(path, readFileSync(join(defaultsRoot, path), "utf8")));
  if (new Set(parsed.map((template) => template.id)).size !== parsed.length) throw new Error("Prompt template ids must be unique");
  catalog = new Map(parsed.map((template) => [template.id, template]));
  for (const template of parsed) for (const oldId of template.renamedFrom) catalog.set(oldId, template);
  return catalog;
}

export function loadDefaultPrompts(): Map<PromptPath, string> {
  if (defaults) return defaults;
  defaults = new Map(PROMPT_PATHS.map((path) => [path, loadPromptCatalog().get(path.slice(0, -3))!.guidance]));
  return defaults;
}

export function composePrompt(defaultPrompt: string, override?: string): string {
  if (!override) return defaultPrompt;
  const frontMatter = override.match(/^---\nmode:\s*(append|replace)\s*\n---\n?/);
  const mode = frontMatter?.[1] ?? "append";
  const guidance = override.slice(frontMatter?.[0].length ?? 0);
  const separator = "\n---contract---\n";
  const index = defaultPrompt.indexOf(separator);
  if (index < 0) return mode === "replace" ? guidance : `${defaultPrompt}\n${guidance}`;
  const contract = defaultPrompt.slice(index + separator.length);
  const baseGuidance = defaultPrompt.slice(0, index);
  return `${mode === "replace" ? guidance : `${baseGuidance}\n${guidance}`}${separator}${contract}`;
}

export function renderPrompt(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Prompt placeholder has no value: ${placeholder}`);
    return value;
  });
}
