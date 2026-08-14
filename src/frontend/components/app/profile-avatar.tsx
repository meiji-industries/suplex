import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar.js";

export type DiceBearCollection = "bottts-neutral" | "pixel-art-neutral";

export function ProfileAvatar({ name, seed, size = "sm", collection = "bottts-neutral" }: { name: string; seed: string; size?: "default" | "xs" | "sm" | "lg"; collection?: DiceBearCollection }) {
  const avatarShape = collection === "pixel-art-neutral" ? "circle" : "square";
  return <Avatar size={size} shape={avatarShape}>
    <AvatarImage src={`https://api.dicebear.com/10.x/${collection}/svg?seed=${encodeURIComponent(seed)}`} alt={`${name} avatar`} />
    <AvatarFallback>{name[0]?.toUpperCase() ?? "?"}</AvatarFallback>
  </Avatar>;
}
