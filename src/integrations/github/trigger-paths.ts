const globPattern = /[*?\[\]{}!]/;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/;
const driveAbsolutePathPattern = /^[a-z]:[\\/]/i;

export class GithubTriggerPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubTriggerPathError";
  }
}

function isRepositoryRelativePath(value: string, allowDirectoryPrefix: boolean): boolean {
  if (!value || value.startsWith("/") || value.includes("\\") || controlCharacterPattern.test(value) || driveAbsolutePathPattern.test(value)) return false;
  const isDirectoryPrefix = value.endsWith("/");
  if (isDirectoryPrefix && !allowDirectoryPrefix) return false;
  const parts = value.split("/");
  if (isDirectoryPrefix) parts.pop();
  return parts.length > 0 && parts.every(part => part !== "" && part !== "." && part !== "..");
}

export function validateGithubTriggerRepositoryFilename(value: string): string {
  if (!isRepositoryRelativePath(value, false)) throw new GithubTriggerPathError(`Repository filename is unsafe: ${value}`);
  return value;
}

export function validateGithubTriggerProtectedPaths(paths: string[]): string[] {
  for (const path of paths) {
    if (!isRepositoryRelativePath(path, true) || globPattern.test(path)) throw new GithubTriggerPathError(`Protected path is unsafe: ${path}`);
  }
  return paths;
}

export function matchesGithubTriggerProtectedPaths(paths: string[], file: { filename: string; previousFilename?: string | null }): boolean {
  validateGithubTriggerProtectedPaths(paths);
  const names = [file.filename, file.previousFilename].filter((name): name is string => name !== undefined && name !== null);
  for (const name of names) validateGithubTriggerRepositoryFilename(name);
  return names.some(name => paths.some(path => path.endsWith("/") ? name.startsWith(path) : name === path));
}
