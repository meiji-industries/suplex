const fixWords = new Set(["fix", "fixes", "fixed", "bug", "bugs", "bugfix", "hotfix", "broken", "crash", "crashes", "repair", "regression"]);
const choreWords = new Set(["chore", "bump", "upgrade", "cleanup", "refactor", "rename", "remove", "deps", "dependency", "dependencies", "docs", "documentation", "ci", "lint"]);
const stopWords = new Set(["a", "an", "the", "to", "for", "of", "in", "on", "and", "with", "we", "i", "use", "using", "instead", "should", "is", "are", "be"]);

export function taskBranchName(title: string, taskId: string): string {
  const words = title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const kind = words.some(word => fixWords.has(word)) ? "fix" : words.some(word => choreWords.has(word)) ? "chore" : "feature";
  const first = words[0] ?? ""; const slugWords = fixWords.has(first) || choreWords.has(first) || ["feat", "feature"].includes(first) ? words.slice(1) : words;
  const slug = slugWords.filter(word => !stopWords.has(word)).slice(0, 4).join("-") || "task";
  return `${kind}/${slug}-${taskId.slice(-6)}`;
}
