

export type AvatarKind = "user" | "company" | "project" | "agent";

export type AvatarShape = "square" | "circle";

export const AVATAR_DEFAULTS: Record<AvatarKind, { shape: AvatarShape; collection: string }> = {
  user: { shape: "circle", collection: "pixel-art-neutral" },
  company: { shape: "square", collection: "initials" },
  project: { shape: "square", collection: "shapes" },
  agent: { shape: "square", collection: "bottts-neutral" },
};

export function dicebearUrl(kind: AvatarKind, seed: string): string {
  return `https://api.dicebear.com/10.x/${AVATAR_DEFAULTS[kind].collection}/svg?seed=${encodeURIComponent(seed)}`;
}
