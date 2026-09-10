import type { NativeHistoryMessage, SessionHistoryPage } from "./contracts.js";

export const sessionHistoryPageSize = 40;

export class SessionHistoryCursorError extends Error {}

export function pageSessionHistory(messages: readonly NativeHistoryMessage[], before?: string, limit = sessionHistoryPageSize): SessionHistoryPage {
  const byId = new Map<string, NativeHistoryMessage>();
  for (const message of messages) byId.set(message.id, message);
  const ordered = [...byId.values()];
  const end = before === undefined ? ordered.length : ordered.findIndex(message => message.id === before);
  if (end < 0) throw new SessionHistoryCursorError("The session history cursor is not available");
  const start = Math.max(0, end - limit);
  return {
    messages: ordered.slice(start, end),
    olderCursor: start > 0 ? ordered[start]!.id : null,
  };
}
