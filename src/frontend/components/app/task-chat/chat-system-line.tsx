import type { ChatItem } from "../../../lib/task-chat.js";

export function ChatSystemLine({ item }: { item: Extract<ChatItem, { kind: "system" }> }) {
  return <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground" data-task-chat-system-line><span aria-hidden="true" className={`size-1.5 rounded-full ${item.tone === "warning" ? "bg-destructive" : item.tone === "success" ? "bg-emerald-600" : "bg-muted-foreground"}`} />{item.text}</div>;
}
