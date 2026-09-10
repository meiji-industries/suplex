import { z } from "zod";
import { readCommandOutput } from "../../platform/command-runner.js";
import { resolveOpenCodeExecutable } from "../../platform/executable-resolver.js";
import { OpenCodeMessageEnvelopeSchema } from "./contracts.js";

export async function readOpenCodeHistory(sessionId: string) {
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) throw new Error("Invalid OpenCode session identity");
  let stdout: string;
  try { stdout = await readCommandOutput(await resolveOpenCodeExecutable(), ["export", "--pure", sessionId]); }
  catch { throw new Error("OpenCode session history is not available"); }
  const exported = z.object({ info: z.object({ id: z.string() }), messages: OpenCodeMessageEnvelopeSchema.array() }).parse(JSON.parse(stdout));
  if (exported.info.id !== sessionId || exported.messages.some(message => message.info.sessionID !== sessionId)) throw new Error("OpenCode returned history for another session");
  return exported.messages;
}
