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
/** Worker-local provider slots. Temporal owns activity distribution. */
export class CapacityManager {
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(private readonly database: ForgeDatabase, private readonly config: Pick<ForgeConfig, "externalTurnCapacity">) {}

  async acquire(provider = "codex", heartbeat?: () => void): Promise<() => void> {
    const limit = this.config.externalTurnCapacity;
    while ((this.active.get(provider) ?? 0) >= limit) {
      heartbeat?.();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        this.waiters.set(provider, [...(this.waiters.get(provider) ?? []), () => { clearTimeout(timer); resolve(); }]);
      });
    }
    this.active.set(provider, (this.active.get(provider) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.set(provider, Math.max(0, (this.active.get(provider) ?? 1) - 1));
      this.waiters.get(provider)?.shift()?.();
    };
  }

  async run<T>(operation: () => Promise<T>, provider = "codex", heartbeat?: () => void): Promise<T> {
    const release = await this.acquire(provider, heartbeat);
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
      effectiveCapacity: profile.capacity ?? this.config.externalTurnCapacity,
      activeCount: this.active.get(profile.provider) ?? 0,
      queuedCount: this.waiters.get(profile.provider)?.length ?? 0,
      rateLimitedCount: 0,
      oldestQueuedAt: null,
    })));
  }
}
