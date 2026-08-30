import { CancelledFailure } from "./engine/failures.js";
import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import type { AdminCapacityLane, PublicCapacityStatus } from "./capacity-contracts.js";
import type { AgentProviderKind } from "./agent-providers/provider.js";


export class CapacityFailure extends Error {
  constructor(readonly code: string) {
    super(`Capacity ${code}`);
    this.name = "CapacityFailure";
  }
}
/** Worker-local provider slots. Engine owns activity distribution. */
export class CapacityManager {
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(private readonly database: ForgeDatabase, private readonly config: Pick<ForgeConfig, "externalTurnCapacity" | "externalTurnCapacityByProvider">) {}

  private limit(provider: string): number {
    // Profile capacity overrides from the admin UI take precedence. The
    // database is optional: older/test callers pass no database and still
    // share the configured default bucket.
    if (this.database) {
      const override = this.database.authQuery((db) => db.prepare("SELECT MAX(capacity) AS capacity FROM forge_profiles WHERE provider = ? AND capacity IS NOT NULL").get(provider) as { capacity?: number | null } | undefined)?.capacity;
      if (typeof override === "number" && Number.isInteger(override) && override > 0) return override;
    }
    // Older/test callers can provide the pre-provider config shape. Every
    // provider must still share the configured default bucket in that case.
    return this.config.externalTurnCapacityByProvider?.[provider] ?? this.config.externalTurnCapacity;
  }

  snapshot(provider?: string): Record<string, { activeCount: number; queuedCount: number; capacity: number }> {
    const providers = provider ? [provider] : [...new Set(["codex", ...this.active.keys(), ...this.waiters.keys(), ...Object.keys(this.config.externalTurnCapacityByProvider)])];
    return Object.fromEntries(providers.map((name) => [name, { activeCount: this.active.get(name) ?? 0, queuedCount: this.waiters.get(name)?.length ?? 0, capacity: this.limit(name) }]));
  }

  async acquire(provider = "codex", heartbeat?: (details?: unknown) => void, signal?: AbortSignal): Promise<() => void> {
    const limit = this.limit(provider);
    while ((this.active.get(provider) ?? 0) >= limit) {
      if (signal?.aborted) throw new CancelledFailure("CANCELLED");
      const position = (this.waiters.get(provider)?.length ?? 0) + 1;
      heartbeat?.({ queued: true, provider, position, activeCount: this.active.get(provider) ?? 0 });
      await new Promise<void>((resolve, reject) => {
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(new CancelledFailure("CANCELLED")); };
        const timer = setTimeout(wake, 1_000);
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          const queue = this.waiters.get(provider);
          if (queue) this.waiters.set(provider, queue.filter((waiter) => waiter !== wake));
        };
        this.waiters.set(provider, [...(this.waiters.get(provider) ?? []), wake]);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (signal?.aborted) throw new CancelledFailure("CANCELLED");
    this.active.set(provider, (this.active.get(provider) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.set(provider, Math.max(0, (this.active.get(provider) ?? 1) - 1));
      this.waiters.get(provider)?.shift()?.();
    };
  }

  async run<T>(operation: () => Promise<T>, provider = "codex", heartbeat?: (details?: unknown) => void, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(provider, heartbeat, signal);
    try { return await operation(); } finally { release(); }
  }

  /** Counters are process-local, so a new worker starts empty. */
  reconcileFromLedgers(): number { return 0; }

  statusForTask(_taskId: string): PublicCapacityStatus | null { return null; }

  listAdminLanes(): AdminCapacityLane[] {
    return this.database.authQuery((db) => (db.prepare("SELECT id, name, provider, capacity FROM forge_profiles ORDER BY name, id").all() as Array<{ id: string; name: string; provider: AgentProviderKind; capacity: number | null }>).map((profile) => ({
      profileId: profile.id,
      profileName: profile.name,
      provider: profile.provider,
      capacity: profile.capacity,
      effectiveCapacity: profile.capacity ?? this.limit(profile.provider),
      activeCount: this.active.get(profile.provider) ?? 0,
      queuedCount: this.waiters.get(profile.provider)?.length ?? 0,
      rateLimitedCount: 0,
      oldestQueuedAt: null,
    })));
  }
}
