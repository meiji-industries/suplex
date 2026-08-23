import { Markdown } from "../markdown.js";
import { ProfileAvatar } from "../profile-avatar.js";
import type { ChatItem } from "../../../lib/task-chat.js";

export function ChatMemberMessage({ item }: { item: Extract<ChatItem, { kind: "member" }> }) {
  return <div className="flex justify-end gap-2" data-task-chat-member-message><div className="max-w-[85%] rounded-md bg-muted px-3 py-2 text-[13px]"><Markdown source={item.markdown} /></div><div className="space-y-1 text-right"><ProfileAvatar name={item.actor.name} seed={item.actor.avatarSeed} size="xs" /><time className="block text-[11px] text-muted-foreground" dateTime={item.at}>{new Date(item.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div></div>;
}
