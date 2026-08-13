import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar.js";

export type DiceBearCollection = "pixelbot" | "pixel-art-neutral";

export function ProfileAvatar({ name, seed, size = "sm", collection = "pixelbot" }: { name: string; seed: string; size?: "default" | "xs" | "sm" | "lg"; collection?: DiceBearCollection }) {
  return <Avatar size={size}>
    <AvatarImage src={`https://api.dicebear.com/10.x/${collection}/svg?seed=${encodeURIComponent(seed)}`} alt={`${name} avatar`} />
    <AvatarFallback>{name[0]?.toUpperCase() ?? "?"}</AvatarFallback>
  </Avatar>;
}
