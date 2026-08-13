import { isAbsolute, resolve } from "node:path";

export interface CodexTurnSettings {
  model: string;
  reasoningLevel: "low" | "medium" | "high";
  servicePriority: "standard" | "priority";
}

export interface CodexTurnArgsInput extends CodexTurnSettings {
  outputSchemaPath: string;
  finalOutputPath?: string;
  repositoryPath: string;
  prompt: string;
  resumeSessionId?: string;
  imagePaths?: string[];
}

function safeIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function safeAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes("\0")) throw new Error(`${label} is invalid`);
  const canonical = resolve(value);
  if (canonical !== value) throw new Error(`${label} must be canonical`);
  return canonical;
}

function configOverride(key: string, value: string): string {
  return `${key}="${value}"`;
}

export function buildCodexTurnArgs(input: CodexTurnArgsInput): string[] {
  const model = safeIdentifier(input.model, "Codex model");
  const outputSchemaPath = safeAbsolutePath(input.outputSchemaPath, "Codex output schema path");
  const repositoryPath = safeAbsolutePath(input.repositoryPath, "Codex repository path");
  if (!input.prompt || input.prompt.includes("\0") || input.prompt.length > 200_000) throw new Error("Codex prompt is invalid");
  if (!["low", "medium", "high"].includes(input.reasoningLevel)) throw new Error("Codex reasoning level is invalid");
  if (!["standard", "priority"].includes(input.servicePriority)) throw new Error("Codex service priority is invalid");
  const images = (input.imagePaths ?? []).map((path) => safeAbsolutePath(path, "Codex image path"));
  const args = input.resumeSessionId
    ? ["exec", "resume", safeIdentifier(input.resumeSessionId, "Codex session"), "--json", "--strict-config", "--ignore-user-config", "--output-schema", outputSchemaPath, "--model", model, "-c", configOverride("model_reasoning_effort", input.reasoningLevel)]
    : ["exec", "--json", "--strict-config", "--ignore-user-config", "--skip-git-repo-check", "--output-schema", outputSchemaPath, ...(input.finalOutputPath ? ["--output-last-message", safeAbsolutePath(input.finalOutputPath, "Codex final output path")] : []), "--model", model, "-c", configOverride("model_reasoning_effort", input.reasoningLevel), "-C", repositoryPath, "--sandbox", "read-only", ...images.flatMap((path) => ["--image", path])];
  if (input.servicePriority === "priority") args.push("-c", configOverride("service_tier", "fast"));
  // Keep prompts out of argv (and avoid the variadic --image option consuming
  // the prompt); the detached wrapper supplies it over stdin.
  args.push("-");
  return args;
}

export const buildCodexExecArgs = buildCodexTurnArgs;

export function validateCodexTurnSettings(settings: CodexTurnSettings): CodexTurnSettings {
  buildCodexTurnArgs({ ...settings, outputSchemaPath: "/schema.json", repositoryPath: "/repository", prompt: "probe" });
  return settings;
}

export function catalogSupportsCodexTurn(catalog: unknown, settings: { model: string; reasoningLevel: string; servicePriority: string }): boolean {
  if (!catalog || typeof catalog !== "object" || !("models" in catalog) || !Array.isArray(catalog.models)) return false;
  const model = catalog.models.find((candidate) => candidate && typeof candidate === "object" && "slug" in candidate && candidate.slug === settings.model) as Record<string, unknown> | undefined;
  if (!model || !Array.isArray(model.supported_reasoning_levels) || !model.supported_reasoning_levels.some((level) => level && typeof level === "object" && "effort" in level && level.effort === settings.reasoningLevel)) return false;
  return settings.servicePriority === "standard" || (Array.isArray(model.service_tiers) && model.service_tiers.some((tier) => tier && typeof tier === "object" && "id" in tier && tier.id === "priority"));
}
