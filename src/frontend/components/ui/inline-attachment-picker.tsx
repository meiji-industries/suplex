import { ImageIcon, Paperclip, X } from "lucide-react";
import * as React from "react";

import { Button } from "./button.js";

export interface InlineAttachmentItem {
  id: string;
  filename: string;
  previewUrl?: string;
}

function InlineAttachmentPicker({
  attachments,
  onSelect,
  onRemove,
  disabled = false,
  maxFiles = 8,
  compact = false,
}: {
  attachments: InlineAttachmentItem[];
  onSelect: (files: File[]) => void | Promise<void>;
  onRemove: (index: number) => void;
  disabled?: boolean;
  maxFiles?: number;
  compact?: boolean;
}): React.ReactElement {
  const inputRef = React.useRef<HTMLInputElement>(null);

  const selectFiles = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length) void onSelect(files);
  };

  return (
    <div className="grid gap-2" data-slot="inline-attachment-picker">
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        aria-label="Task images"
        disabled={disabled || attachments.length >= maxFiles}
        onChange={selectFiles}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size={compact ? "icon-sm" : "sm"} aria-label={compact ? "Add images" : undefined} title={compact ? "Add images" : undefined} disabled={disabled || attachments.length >= maxFiles} onClick={() => inputRef.current?.click()}>
          <Paperclip className="size-3.5" />
          {compact ? null : "Add images"}
        </Button>
        {compact ? null : <span className="text-[11px] text-muted-foreground">PNG, JPEG, WebP, or GIF · {attachments.length}/{maxFiles}</span>}
      </div>
      {attachments.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Selected attachments" aria-live="polite">
          {attachments.map((attachment, index) => (
            <li className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-md bg-muted/35 pl-1 pr-0.5" key={attachment.id}>
              {attachment.previewUrl ? <img className="size-6 rounded-sm object-cover" src={attachment.previewUrl} alt="" /> : <span className="flex size-6 items-center justify-center text-muted-foreground"><ImageIcon className="size-3.5" /></span>}
              <span className="max-w-44 truncate text-[11px]" title={attachment.filename}>{attachment.filename}</span>
              <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={`Remove ${attachment.filename}`} disabled={disabled} onClick={() => onRemove(index)}><X className="size-3" /></Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export { InlineAttachmentPicker };
