import { CancelledFailure } from "./engine/failures.js";
import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import type { AdminCapacityLane, PublicCapacityStatus } from "./capacity-contracts.js";
import type { AgentProviderKind } from "./agent-providers/provider.js";

export interface CapacityProfileIdentity {
  id: string;
  provider: AgentProviderKind;
  name: string;
  agentName?: string;
}

export interface CapacityQueueDetails {
  queued: true;
  profileId: string;
  profileName: string;
  provider: AgentProviderKind;
  agentName?: string;
  position: number;
  activeCount: number;
  capacity: number;
}

type CapacityLane = CapacityProfileIdentity | AgentProviderKind;

export class CapacityFailure extends Error {
  constructor(readonly code: string) {
    super(`Capacity ${code}`);
    this.name = "CapacityFailure";
  }
}
/** Worker-local profile slots. Engine owns activity distribution. */
export class CapacityManager {
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(private readonly database: ForgeDatabase, private readonly config: Pick<ForgeConfig, "externalTurnCapacity" | "externalTurnCapacityByProvider">) {}

  private profileLimit(profileId: string): number {
    const profile = this.database.authQuery((db) => db.prepare("SELECT provider, capacity FROM forge_profiles WHERE id = ?").get(profileId) as { provider: AgentProviderKind; capacity: number | null } | undefined);
    if (!profile) throw new CapacityFailure("profile-unavailable");
    return profile.capacity ?? this.config.externalTurnCapacityByProvider?.[profile.provider] ?? this.config.externalTurnCapacity;
  }

  private providerLimit(provider: AgentProviderKind): number {
    const override = this.database.authQuery((db) => db.prepare("SELECT MAX(capacity) AS capacity FROM forge_profiles WHERE provider = ? AND capacity IS NOT NULL").get(provider) as { capacity?: number | null } | undefined)?.capacity;
    return typeof override === "number" && Number.isInteger(override) && override > 0
      ? override
      : this.config.externalTurnCapacityByProvider?.[provider] ?? this.config.externalTurnCapacity;
  }

  snapshot(profileIdOrProvider?: string): Record<string, { activeCount: number; queuedCount: number; capacity: number }> {
    const exactProfile = profileIdOrProvider
      ? this.database.authQuery((db) => db.prepare("SELECT id FROM forge_profiles WHERE id = ?").get(profileIdOrProvider) as { id: string } | undefined)
      : undefined;
    if (profileIdOrProvider && !exactProfile) {
      const provider = profileIdOrProvider as AgentProviderKind;
      return { [provider]: { activeCount: this.active.get(provider) ?? 0, queuedCount: this.waiters.get(provider)?.length ?? 0, capacity: this.providerLimit(provider) } };
    }
    const profileIds = exactProfile
      ? [exactProfile.id]
      : this.database.authQuery((db) => (db.prepare("SELECT id FROM forge_profiles ORDER BY id").all() as Array<{ id: string }>).map((profile) => profile.id));
    return Object.fromEntries(profileIds.map((id) => [id, { activeCount: this.active.get(id) ?? 0, queuedCount: this.waiters.get(id)?.length ?? 0, capacity: this.profileLimit(id) }]));
  }

  async acquire(lane: CapacityLane = "codex", heartbeat?: (details?: unknown) => void, signal?: AbortSignal): Promise<() => void> {
    const legacyProvider = typeof lane === "string" ? lane : undefined;
    const profile = typeof lane === "string" ? undefined : lane;
    const laneId = profile?.id ?? legacyProvider!;
    while (true) {
      const capacity = profile ? this.profileLimit(profile.id) : this.providerLimit(legacyProvider!);
      const activeCount = this.active.get(laneId) ?? 0;
      if (activeCount < capacity) break;
      if (signal?.aborted) throw new CancelledFailure("CANCELLED");
      const position = (this.waiters.get(laneId)?.length ?? 0) + 1;
      heartbeat?.(profile
        ? { queued: true, profileId: profile.id, profileName: profile.name, provider: profile.provider, ...(profile.agentName ? { agentName: profile.agentName } : {}), position, activeCount, capacity } satisfies CapacityQueueDetails
        : { queued: true, provider: legacyProvider, position, activeCount });
      await new Promise<void>((resolve, reject) => {
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(new CancelledFailure("CANCELLED")); };
        const timer = setTimeout(wake, 1_000);
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          const queue = this.waiters.get(laneId);
          if (queue) this.waiters.set(laneId, queue.filter((waiter) => waiter !== wake));
        };
        this.waiters.set(laneId, [...(this.waiters.get(laneId) ?? []), wake]);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (signal?.aborted) throw new CancelledFailure("CANCELLED");
    this.active.set(laneId, (this.active.get(laneId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.set(laneId, Math.max(0, (this.active.get(laneId) ?? 1) - 1));
      this.waiters.get(laneId)?.shift()?.();
    };
  }

  async run<T>(operation: () => Promise<T>, lane: CapacityLane = "codex", heartbeat?: (details?: unknown) => void, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(lane, heartbeat, signal);
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
      effectiveCapacity: this.profileLimit(profile.id),
      activeCount: this.active.get(profile.id) ?? 0,
      queuedCount: this.waiters.get(profile.id)?.length ?? 0,
      rateLimitedCount: 0,
      oldestQueuedAt: null,
    })));
  }
}
