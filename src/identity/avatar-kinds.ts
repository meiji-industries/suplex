// Keep this module dependency free for the frontend bundle.
export type AvatarKind = "user" | "company" | "project" | "agent";
export type AvatarShape = "square" | "circle";

export const AVATAR_DEFAULTS: Record<AvatarKind, { shape: AvatarShape; collection: string }> = {
  user: { shape: "circle", collection: "pixel-art-neutral" },
  company: { shape: "square", collection: "initials" },
  project: { shape: "square", collection: "shapes" },
  agent: { shape: "square", collection: "bottts-neutral" },
};

export const MAX_AVATAR_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_AVATAR_IMAGE_BASE64_LENGTH = Math.ceil(MAX_AVATAR_IMAGE_BYTES / 3) * 4;

export function dicebearUrl(kind: AvatarKind, seed: string): string {
  return `https://api.dicebear.com/10.x/${AVATAR_DEFAULTS[kind].collection}/svg?seed=${encodeURIComponent(seed)}`;
}
