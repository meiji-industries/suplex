import type { ForgeDatabase } from "./database.js";
import { ProjectFailure } from "./projects.js";

export type ProviderCredential = "openrouter";
type Row = { secret: string; last_four: string; last_tested_at: string | null; last_test_status: "healthy" | "unhealthy" | null; last_test_summary: string | null };
export class ProviderCredentialStore {
  constructor(private readonly database: ForgeDatabase) {}
  get(provider: ProviderCredential) {
    const row = this.database.authQuery((db) => db.prepare("SELECT secret, last_four, last_tested_at, last_test_status, last_test_summary FROM forge_provider_credentials WHERE provider = ?").get(provider) as Row | undefined);
    return row && { secret: row.secret, lastFour: row.last_four, lastTestedAt: row.last_tested_at, lastTestStatus: row.last_test_status, lastTestSummary: row.last_test_summary };
  }
  set(provider: ProviderCredential, value: string) {
    const secret = value.trim();
    if (!secret || /\s/.test(secret)) throw new ProjectFailure("Provider API key is invalid", [{ code: "invalid", field: "apiKey", message: "API key must not contain spaces" }]);
    const now = new Date().toISOString();
    this.database.authQuery((db) => db.prepare("INSERT INTO forge_provider_credentials (provider, secret, last_four, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET secret = excluded.secret, last_four = excluded.last_four, updated_at = excluded.updated_at").run(provider, secret, secret.slice(-4), now, now));
  }
  clear(provider: ProviderCredential) { this.database.authQuery((db) => db.prepare("DELETE FROM forge_provider_credentials WHERE provider = ?").run(provider)); }
  recordTest(provider: ProviderCredential, status: "healthy" | "unhealthy", summary: string) { this.database.authQuery((db) => db.prepare("UPDATE forge_provider_credentials SET last_tested_at = ?, last_test_status = ?, last_test_summary = ?, updated_at = ? WHERE provider = ?").run(new Date().toISOString(), status, summary, new Date().toISOString(), provider)); }
  describe(provider: ProviderCredential) { const row = this.get(provider); return { configured: Boolean(row), maskedKey: row ? `…${row.lastFour}` : null, lastTestedAt: row?.lastTestedAt ?? null, lastTestStatus: row?.lastTestStatus ?? null, lastTestSummary: row?.lastTestSummary ?? null }; }
}

export async function testOpenRouterKey(secret: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5_000): Promise<{ ok: boolean; summary: string; details: Record<string, string | number | boolean> }> {
  try {
    const response = await fetchImpl("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 401 || response.status === 403) return { ok: false, summary: "OpenRouter rejected the API key", details: {} };
    if (!response.ok) return { ok: false, summary: "OpenRouter is unreachable", details: { status: response.status } };
    const data = (await response.json() as { data?: Record<string, unknown> }).data ?? {};
    const details: Record<string, string | number | boolean> = {};
    for (const [from, to] of [["label", "label"], ["limit", "limit"], ["usage", "usage"], ["is_free_tier", "isFreeTier"], ["isFreeTier", "isFreeTier"]] as const) if (typeof data[from] === "string" || typeof data[from] === "number" || typeof data[from] === "boolean") details[to] = data[from] as string | number | boolean;
    return { ok: true, summary: "OpenRouter API key is valid", details };
  } catch { return { ok: false, summary: "OpenRouter is unreachable", details: {} }; }
}
