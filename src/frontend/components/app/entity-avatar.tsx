import { Circle, Square, Trash2, Upload } from "lucide-react";
import { useRef, useState, type ReactElement } from "react";
import { AVATAR_DEFAULTS, dicebearUrl, type AvatarKind } from "./avatar-presentation.js";
import { MAX_AVATAR_IMAGE_BYTES } from "../../contracts/avatar-limits.js";
import type { AvatarUpdateBody } from "../../contracts/avatars.js";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar.js";
import { Button } from "../ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.js";
import { useOptionalCompanyContext } from "../../shell/company-context.js";

export type { AvatarKind };

interface EntityAvatarProps {
  kind: AvatarKind;
  id: string;
  name: string;
  /** DiceBear seed for the default image. Without it Suplex resolves the default on the server. */
  seed?: string;
  size?: "default" | "xs" | "sm" | "lg";
}

/** One renderer for every avatar: uploaded image first, then the DiceBear default, then the initial letter. */
export function EntityAvatar({ kind, id, name, seed, size = "sm" }: EntityAvatarProps): ReactElement {
  const record = useOptionalCompanyContext()?.avatars[id];
  const base = `/api/avatars/${encodeURIComponent(id)}`;
  const src = record?.imageVersion ? `${base}?v=${encodeURIComponent(record.imageVersion)}` : seed ? dicebearUrl(kind, seed) : base;
  return <Avatar size={size} shape={record?.shape ?? AVATAR_DEFAULTS[kind].shape}>
    <AvatarImage src={src} alt={`${name} avatar`} />
    <AvatarFallback>{name[0]?.toUpperCase() ?? "?"}</AvatarFallback>
  </Avatar>;
}

/** Shape choice plus image upload. Saves on every change. */
export function AvatarEditor({ kind, id, name, seed, compact = false }: Omit<EntityAvatarProps, "size"> & { compact?: boolean }): ReactElement {
  const context = useOptionalCompanyContext();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const record = context?.avatars[id];
  const nextShape = (record?.shape ?? AVATAR_DEFAULTS[kind].shape) === "square" ? "circle" : "square";
  const save = async (patch: AvatarUpdateBody): Promise<void> => {
    if (!context) return;
    setBusy(true); setError("");
    try { await context.saveAvatar(id, patch); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save the avatar"); }
    finally { setBusy(false); }
  };
  const upload = (file: File | undefined): void => {
    if (!file) return;
    if (file.size > MAX_AVATAR_IMAGE_BYTES) { setError("Select an image up to 2 MB."); return; }
    const reader = new FileReader();
    reader.onload = () => void save({ image: { mimeType: file.type as NonNullable<AvatarUpdateBody["image"]>["mimeType"], base64: String(reader.result).split(",")[1] ?? "" } });
    reader.readAsDataURL(file);
  };
  return <div className="flex flex-wrap items-center gap-2">
    {compact ? <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-lg" disabled={busy || !context} aria-label="Edit avatar" />} onContextMenu={event => { if (busy || !context) return; event.preventDefault(); setMenuOpen(true); }}>
        <EntityAvatar kind={kind} id={id} name={name} {...(seed ? { seed } : {})} size="lg" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-40">
        <DropdownMenuItem disabled={busy} onClick={() => void save({ shape: nextShape })}>{nextShape === "circle" ? <Circle /> : <Square />}Use {nextShape}</DropdownMenuItem>
        {record?.imageVersion
          ? <DropdownMenuItem disabled={busy} onClick={() => void save({ image: null })}><Trash2 />Remove avatar</DropdownMenuItem>
          : <DropdownMenuItem disabled={busy} onClick={() => input.current?.click()}><Upload />Upload avatar</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu> : <>
    <EntityAvatar kind={kind} id={id} name={name} {...(seed ? { seed } : {})} size="lg" />
    <Select value={record?.shape ?? AVATAR_DEFAULTS[kind].shape} onValueChange={(value) => { if (value === "square" || value === "circle") void save({ shape: value }); }}>
      <SelectTrigger size="sm" aria-label="Avatar shape"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="square">Square</SelectItem><SelectItem value="circle">Circle</SelectItem></SelectContent>
    </Select>
    <Button type="button" variant="outline" size="sm" disabled={busy || !context} onClick={() => input.current?.click()}><Upload className="size-3.5" />Upload image</Button>
    {record?.imageVersion ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void save({ image: null })}><Trash2 className="size-3.5" />Delete image</Button> : null}
    </>}
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" aria-label="Avatar image" onChange={(event) => { upload(event.target.files?.[0]); event.target.value = ""; }} />
    {error ? <span className="text-xs text-destructive">{error}</span> : null}
  </div>;
}
