export function json<T>(raw: string, fallback: T): T;
export function json(raw: string, fallback: undefined): unknown;
export function json(raw: string, fallback: unknown): unknown { try { return JSON.parse(raw); } catch { return fallback; } }
export function jsonRequired(raw: string): ReturnType<typeof JSON.parse> { return JSON.parse(raw); }
