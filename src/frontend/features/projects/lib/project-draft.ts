// A repository the user typed before leaving for billing settings. Only the
// repository location is stored, per company, for the browser session.
export type ProjectDraft = { source: "clone" | "create"; repository: string };

const prefix = "suplex-project-draft:";

export function readProjectDraft(companyId: string): ProjectDraft | undefined {
  try {
    const draft: unknown = JSON.parse(window.sessionStorage.getItem(prefix + companyId) ?? "null");
    if (typeof draft !== "object" || draft === null) return undefined;
    const { source, repository } = draft as Record<string, unknown>;
    return (source === "clone" || source === "create") && typeof repository === "string" ? { source, repository } : undefined;
  } catch {
    return undefined;
  }
}

export function writeProjectDraft(companyId: string, draft: ProjectDraft): void {
  try { window.sessionStorage.setItem(prefix + companyId, JSON.stringify(draft)); } catch { /* Browser storage can be disabled. */ }
}

export function clearProjectDraft(companyId: string): void {
  try { window.sessionStorage.removeItem(prefix + companyId); } catch { /* Browser storage can be disabled. */ }
}

// Sign-out removes every draft so no company data outlives the session.
export function clearProjectDrafts(): void {
  try {
    for (const key of Object.keys(window.sessionStorage)) if (key.startsWith(prefix)) window.sessionStorage.removeItem(key);
  } catch { /* Browser storage can be disabled. */ }
}
