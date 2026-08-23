import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "./command-runner.js";

export const PROMPT_PATHS = [
  "developer/execution.md", "developer/repair.md", "developer/ci-repair.md", "developer/merge-resolution.md", "developer/integrator.md",
  "lead/plan.md", "lead/review.md", "lead/consolidation.md", "lead/delivery-review.md", "lead/delivery-repair-plan.md", "lead/ci-repair.md", "lead/merge-conflict-plan.md", "lead/integrator.md",
  "pull-request/guidance.md", "pull-request/body.md",
] as const;
export type PromptPath = typeof PROMPT_PATHS[number];

const defaultsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
let defaults: Map<PromptPath, string> | undefined;

export function loadDefaultPrompts(): Map<PromptPath, string> {
  if (defaults) return defaults;
  defaults = new Map(PROMPT_PATHS.map((path) => [path, readFileSync(join(defaultsRoot, path), "utf8")]));
  return defaults;
}

export async function resolveProjectPrompts(repositoryPath: string, baseSha: string): Promise<Map<PromptPath, string>> {
  const overrides = new Map<PromptPath, string>();
  await Promise.all(PROMPT_PATHS.map(async (path) => {
    const result = await runCommand({ taskId: null, stepId: null, command: "git", args: ["show", `${baseSha}:.forge/prompts/${path}`], cwd: repositoryPath, timeout: 30_000 });
    if (result.exitCode === 0 && !result.timedOut) overrides.set(path, result.stdout);
  }));
  return overrides;
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

