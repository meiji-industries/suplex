import { AuthFailure, type AuthService } from "./auth.js";
import type { AvatarKind } from "./avatar-kinds.js";
import { MAX_AVATAR_IMAGE_BYTES } from "./avatar-kinds.js";
import type { SuplexDatabase } from "../platform/database.js";
import type { AvatarRecord, AvatarUpdateBody } from "../http/contracts/avatars.js";
import { decodeTaskImage } from "../tasks/images.js";
import { ArtifactFailure } from "../platform/artifacts.js";

interface AvatarRow { owner_id: string; shape: AvatarRecord["shape"]; mime_type: string | null; image: Buffer | null; updated_at: string }

// Owner ids are globally unique across tables, so one lookup per table resolves the kind.
const ownerTables: Array<[AvatarKind, string]> = [["user", "suplex_users"], ["company", "suplex_companies"], ["project", "suplex_projects"], ["agent", "suplex_profiles"], ["agent", "suplex_agents"]];

export class AvatarService {
  constructor(private readonly database: SuplexDatabase, private readonly auth: AuthService) {}

  list(userId: string): Record<string, AvatarRecord> {
    this.user(userId);
    const rows = this.database.authQuery(db => db.prepare("SELECT owner_id, shape, updated_at, mime_type IS NOT NULL AS has_image FROM suplex_avatars").all() as Array<{ owner_id: string; shape: AvatarRecord["shape"]; updated_at: string; has_image: number }>);
    return Object.fromEntries(rows.map(row => [row.owner_id, { shape: row.shape, imageVersion: row.has_image ? row.updated_at : null }]));
  }

  /** Resolve the owner kind and, for a kind without an upload, the dicebear seed. */
  owner(userId: string, ownerId: string): { kind: AvatarKind; seed: string } {
    this.user(userId);
    const found = this.database.authQuery(db => {
      for (const [kind, table] of ownerTables) {
        const row = db.prepare(`SELECT ${table === "suplex_users" ? "COALESCE(NULLIF(avatar_seed, ''), username)" : table === "suplex_companies" ? "name" : table === "suplex_projects" ? "id" : "avatar_seed"} AS seed FROM ${table} WHERE id = ?`).get(ownerId) as { seed: string } | undefined;
        if (row) return { kind, seed: row.seed };
      }
      return undefined;
    });
    if (!found) throw new AuthFailure("Not found", 404);
    return found;
  }

  image(userId: string, ownerId: string): { mimeType: string; image: Buffer; updatedAt: string } | undefined {
    this.user(userId);
    const row = this.database.authQuery(db => db.prepare("SELECT mime_type, image, updated_at FROM suplex_avatars WHERE owner_id = ? AND image IS NOT NULL").get(ownerId) as Pick<AvatarRow, "mime_type" | "image" | "updated_at"> | undefined);
    return row?.image && row.mime_type ? { mimeType: row.mime_type, image: row.image, updatedAt: row.updated_at } : undefined;
  }

  update(userId: string, ownerId: string, patch: AvatarUpdateBody): AvatarRecord {
    const actor = this.user(userId);
    const bytes = patch.image ? decodeTaskImage({ ...patch.image, filename: "avatar" }) : undefined;
    if (bytes && bytes.length > MAX_AVATAR_IMAGE_BYTES) throw new ArtifactFailure("invalid-image-data", "Image data is invalid or too large");
    return this.database.authTransaction(db => {
      const kind = ownerTables.find(([, table]) => db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(ownerId))?.[0];
      if (!kind) throw new AuthFailure("Not found", 404);
      const allowed = actor.role === "admin"
        || (kind === "user" && ownerId === actor.id)
        || (kind === "project" && Boolean(db.prepare("SELECT 1 FROM suplex_projects p JOIN suplex_memberships m ON m.company_id = p.company_id WHERE p.id = ? AND m.user_id = ?").get(ownerId, actor.id)));
      if (!allowed) throw new AuthFailure("Administrator access required", 403);
      const current = db.prepare("SELECT owner_id, shape, mime_type, image, updated_at FROM suplex_avatars WHERE owner_id = ?").get(ownerId) as AvatarRow | undefined;
      const shape = patch.shape === undefined ? current?.shape ?? null : patch.shape;
      const mimeType = patch.image === undefined ? current?.mime_type ?? null : patch.image?.mimeType ?? null;
      const image = patch.image === undefined ? current?.image ?? null : bytes ?? null;
      const updatedAt = new Date().toISOString();
      if (shape === null && image === null) db.prepare("DELETE FROM suplex_avatars WHERE owner_id = ?").run(ownerId);
      else db.prepare("INSERT INTO suplex_avatars (owner_id, shape, mime_type, image, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner_id) DO UPDATE SET shape = excluded.shape, mime_type = excluded.mime_type, image = excluded.image, updated_at = excluded.updated_at").run(ownerId, shape, mimeType, image, updatedAt);
      this.auth.recordAuditEventInTransaction(db, actor.id, "avatar_updated", kind === "user" ? ownerId : undefined, undefined, { ownerId });
      return { shape, imageVersion: image ? updatedAt : null };
    });
  }

  private user(userId: string) {
    const user = this.auth.getUserForAuthority(userId);
    if (!user) throw new AuthFailure("Authentication required", 401);
    return user;
  }
}
