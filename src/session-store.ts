import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AgentFailure } from "./agent-failure.js";
import { jsonRequired } from "./task-utils.js";

export interface SessionStore {
  create(rawSessionId: string): Promise<string>;
  reserve?(): Promise<string>;
  bind?(sessionRef: string, rawSessionId: string): Promise<void>;
  read(sessionRef: string): Promise<string>;
}

export class FileSessionStore implements SessionStore {
  constructor(private readonly root: string) {}

  async reserve(): Promise<string> {
    const sessionRef = `session_${randomBytes(12).toString("hex")}`;
    const directory = join(this.root, "sessions");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${sessionRef}.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(temporary, JSON.stringify({}), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, join(directory, `${sessionRef}.json`));
    return sessionRef;
  }

  async bind(sessionRef: string, rawSessionId: string): Promise<void> {
    this.validate(sessionRef);
    if (!rawSessionId || rawSessionId.length > 256) throw new AgentFailure("session_identity_conflict", "Lead session identity is invalid");
    const filename = join(this.root, "sessions", `${sessionRef}.json`);
    let current: { sessionId?: unknown };
    try { current = jsonRequired(await readFile(filename, "utf8")) as { sessionId?: unknown }; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AgentFailure("invalid-session-reference", "Lead session reference is not reserved");
      throw error;
    }
    if (typeof current.sessionId === "string" && current.sessionId !== rawSessionId) throw new AgentFailure("session_identity_conflict", "Lead session identity changed");
    if (current.sessionId === rawSessionId) return;
    const temporary = `${filename}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify({ sessionId: rawSessionId }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, filename);
  }

  async create(rawSessionId: string): Promise<string> {
    const sessionRef = await this.reserve();
    await this.bind(sessionRef, rawSessionId);
    return sessionRef;
  }

  async read(sessionRef: string): Promise<string> {
    this.validate(sessionRef);
    const parsed = jsonRequired(await readFile(join(this.root, "sessions", `${sessionRef}.json`), "utf8")) as { sessionId?: unknown };
    if (typeof parsed.sessionId !== "string" || !parsed.sessionId) throw new AgentFailure("invalid-session-reference", "Lead session reference is invalid");
    return parsed.sessionId;
  }

  private validate(sessionRef: string): void {
    if (!/^session_[a-f0-9]{24}$/.test(sessionRef)) throw new AgentFailure("invalid-session-reference", "Lead session reference is invalid");
  }
}
