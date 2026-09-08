import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ReviewRange } from "./workflows.js";

// Task-scoped evidence directories outside the Git worktree: <root>/<taskId>/<evidence-id>/{manifest.json,patch.diff,verification.json,attachments/}.

const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface EvidenceAttachment { artifactId: string; mimeType: string; read: () => Promise<Buffer> }
export interface EvidenceManifest {
  version: 1; taskId: string; createdAt: string; baseSha: string; headSha: string; files: string[]; commits: string[];
  attachments: Array<{ artifactId: string; path: string | null; error: string | null }>;
}

export function taskEvidenceRoot(databasePath: string): string {
  return join(databasePath, "..", "runtime", "task-evidence");
}

async function streamPatch(cwd: string, range: ReviewRange, target: string): Promise<void> {
  const child = spawn("git", ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", `${range.baseSha}...${range.headSha}`, "--"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const exit = new Promise<number | null>(resolve => child.once("close", code => resolve(code)));
  await pipeline(child.stdout, createWriteStream(target, { mode: 0o600 }));
  const code = await exit;
  if (code !== 0) throw new Error(`git diff exited with ${code ?? "signal"}: ${stderr.trim()}`);
}

async function digestFiles(directory: string, relativePaths: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const relative of [...relativePaths].sort()) {
    hash.update(`${relative}\0`);
    await new Promise<void>((resolve, reject) => {
      createReadStream(join(directory, relative)).on("data", chunk => hash.update(chunk)).once("end", resolve).once("error", reject);
    });
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function listEvidenceFiles(directory: string): Promise<string[]> {
  const attachments = await readdir(join(directory, "attachments")).catch(() => [] as string[]);
  return ["manifest.json", "patch.diff", "verification.json", ...attachments.map(name => `attachments/${name}`)];
}

/** Writes every evidence file into a pending directory and publishes it only after all writes finish. */
export async function writeTaskEvidence(input: { root: string; taskId: string; worktree: string; range: ReviewRange; attachments: EvidenceAttachment[]; verification: unknown }): Promise<{ directory: string; sha256: string }> {
  if (!idPattern.test(input.taskId)) throw new Error("Invalid task evidence identity");
  const taskRoot = join(input.root, input.taskId);
  await mkdir(taskRoot, { recursive: true, mode: 0o700 });
  await chmod(taskRoot, 0o700);
  const id = `evidence_${randomUUID().replaceAll("-", "")}`;
  const pending = join(taskRoot, `${id}.pending`);
  const directory = join(taskRoot, id);
  await mkdir(join(pending, "attachments"), { recursive: true, mode: 0o700 });
  try {
    await streamPatch(input.worktree, input.range, join(pending, "patch.diff"));
    const attachments: EvidenceManifest["attachments"] = [];
    for (const attachment of input.attachments) {
      if (!idPattern.test(attachment.artifactId)) { attachments.push({ artifactId: attachment.artifactId, path: null, error: "invalid artifact identity" }); continue; }
      const extension = extensions[attachment.mimeType];
      if (!extension) { attachments.push({ artifactId: attachment.artifactId, path: null, error: `unsupported type ${attachment.mimeType}` }); continue; }
      try {
        const bytes = await attachment.read();
        const name = `${attachment.artifactId}.${extension}`;
        await writeFile(join(pending, "attachments", name), bytes, { mode: 0o600 });
        attachments.push({ artifactId: attachment.artifactId, path: `attachments/${name}`, error: null });
      } catch (error) {
        attachments.push({ artifactId: attachment.artifactId, path: null, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const manifest: EvidenceManifest = { version: 1, taskId: input.taskId, createdAt: new Date().toISOString(), baseSha: input.range.baseSha, headSha: input.range.headSha, files: input.range.files, commits: input.range.commits, attachments };
    await writeFile(join(pending, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await writeFile(join(pending, "verification.json"), JSON.stringify(input.verification, null, 2), { mode: 0o600 });
    const sha256 = await digestFiles(pending, await listEvidenceFiles(pending));
    await rename(pending, directory);
    return { directory, sha256 };
  } catch (error) {
    await rm(pending, { recursive: true, force: true });
    throw error;
  }
}

export async function readEvidenceManifest(directory: string): Promise<EvidenceManifest> {
  return JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as EvidenceManifest;
}

/** Recomputes the digest over the published files; a missing or changed file never matches. */
export async function verifyTaskEvidence(directory: string, sha256: string): Promise<boolean> {
  try { return await digestFiles(directory, await listEvidenceFiles(directory)) === sha256; }
  catch { return false; }
}
