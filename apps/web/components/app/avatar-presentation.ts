

export type AvatarKind = "user" | "company" | "project" | "agent";

export type AvatarShape = "square" | "circle";

/** `initial`: the default image is only a background, so the initial letter is drawn on it. */
export const AVATAR_DEFAULTS: Record<AvatarKind, { shape: AvatarShape; collection: string; initial?: boolean }> = {
  user: { shape: "circle", collection: "glass", initial: true },
  company: { shape: "square", collection: "initials" },
  project: { shape: "square", collection: "shapes" },
  agent: { shape: "square", collection: "bottts-neutral" },
};

export function dicebearUrl(kind: AvatarKind, seed: string): string {
  return `https://api.dicebear.com/10.x/${AVATAR_DEFAULTS[kind].collection}/svg?seed=${encodeURIComponent(seed)}`;
}
