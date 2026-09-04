import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type { ArtifactStore, StoredArtifact } from "./artifacts.js";
import type { ForgeDatabase } from "./database.js";
import { runCommand } from "./command-runner.js";
import { jsonRequired } from "./task-utils.js";

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const hashSchema = z.string().regex(/^[a-f0-9]{40,64}$/i);
const viewportSchema = z.object({ width: z.number().int().min(1).max(10_000), height: z.number().int().min(1).max(10_000), deviceScaleFactor: z.number().min(0.25).max(8).optional() }).strict();
const captureSchema = z.object({ path: z.string().min(1), caption: z.string().max(500).optional(), viewport: viewportSchema.optional(), capturedAt: z.string().datetime().optional() }).strict();
export const BrowserProofInputSchema = z.object({ captured: z.boolean(), summary: z.string().optional(), paths: z.array(z.string().min(1)).optional(), captures: z.array(captureSchema).optional() }).strict();
export type BrowserProofInput = z.infer<typeof BrowserProofInputSchema>;

const imageSchema = z.object({ artifactId: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), filename: z.string(), mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), byteSize: z.number().int().positive(), caption: z.string().nullable(), viewport: z.object({ width: z.number().int(), height: z.number().int(), deviceScaleFactor: z.number().nullable() }).nullable(), capturedAt: z.string().datetime().nullable() }).strict();
export const BrowserProofManifestSchema = z.object({ version: z.literal(1), taskId: z.string(), companyId: z.string(), developerExecutionId: z.string(), resultCommit: hashSchema, resultTree: hashSchema, summary: z.string().nullable(), createdAt: z.string().datetime(), images: z.array(imageSchema).min(1).max(MAX_IMAGES) }).strict();
export type BrowserProofManifest = z.infer<typeof BrowserProofManifestSchema>;
export type BrowserProofProjection = BrowserProofManifest & { manifestArtifactId: string };
export type DurableBrowserProof = { captured: true; manifestArtifactId: string; artifactIds: string[]; summary?: string };
export type BrowserProofDownload = { kind: "browser-proof-image" | "browser-proof-manifest"; filename: string; mimeType: string; bytes: Buffer };

export class BrowserProofFailure extends Error {
  constructor(readonly code: "proof-identity-conflict", message: string) { super(message); this.name = "BrowserProofFailure"; }
}

class BrowserProofAdvisory extends Error {}

type ArtifactRow = { id: string; companyId: string; taskId: string; kind: string; filename: string; mimeType: string; byteSize: number; sha256: string; storagePath: string; createdAt: string };
const rowSelect = "id, company_id AS companyId, task_id AS taskId, kind, filename, mime_type AS mimeType, byte_size AS byteSize, sha256, storage_path AS storagePath, created_at AS createdAt";
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const deterministicId = (prefix: string, parts: unknown[]): string => `${prefix}_${sha256(JSON.stringify(parts)).slice(0, 48)}`;
const inside = (root: string, target: string): boolean => { const value = relative(root, target); return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value)); };

function imageType(reportedPath: string): { mimeType: "image/png" | "image/jpeg" | "image/webp"; extension: "png" | "jpg" | "webp" } | undefined {
  switch (extname(reportedPath).toLowerCase()) {
    case ".png": return { mimeType: "image/png", extension: "png" };
    case ".jpg":
    case ".jpeg": return { mimeType: "image/jpeg", extension: "jpg" };
    case ".webp": return { mimeType: "image/webp", extension: "webp" };
    default: return undefined;
  }
}

function safeFilename(reportedPath: string, ordinal: number, extension: string): string {
  const stem = basename(reportedPath).normalize("NFKC").replace(/\.[^.]*$/, "").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/[-_.]{2,}/g, "-").replace(/^[-_.]+|[-_.]+$/g, "").slice(0, 110);
  return `${stem || `proof-${ordinal + 1}`}.${extension}`;
}

function normalizedCaptures(input: BrowserProofInput): z.infer<typeof captureSchema>[] {
  const parsed = BrowserProofInputSchema.parse(input);
  const captures = [...(parsed.captures ?? []), ...(parsed.paths ?? []).map((path) => ({ path }))];
  if (!parsed.captured && captures.length) throw new BrowserProofAdvisory("Browser proof report is contradictory");
  const unique = new Map<string, z.infer<typeof captureSchema>>();
  for (const capture of captures) {
    const path = normalizeBrowserProofPath(capture.path);
    if (!unique.has(path)) unique.set(path, { ...capture, path });
  }
  return [...unique.values()];
}

export function normalizeBrowserProofPath(value: string): string {
  if (isAbsolute(value) || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value) || value.startsWith(":") || value.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(":")) || !value.startsWith(".forge-proof/") || value === ".forge-proof/") throw new BrowserProofAdvisory("Browser proof source is outside the allowed staging directory");
  return value;
}

export function normalizeBrowserProofPaths(input?: BrowserProofInput): string[] {
  return input ? normalizedCaptures(input).map((capture) => capture.path) : [];
}

async function readCapture(worktreePath: string, reportedPath: string): Promise<Buffer> {
  reportedPath = normalizeBrowserProofPath(reportedPath);
  let worktree: string, proofRoot: string, source: string;
  try {
    worktree = await realpath(worktreePath);
    proofRoot = await realpath(resolve(worktree, ".forge-proof"));
    source = await realpath(resolve(worktree, reportedPath));
  } catch { throw new BrowserProofAdvisory("Browser proof source is unavailable"); }
  if (!inside(worktree, proofRoot) || !inside(proofRoot, source)) throw new BrowserProofAdvisory("Browser proof source is outside the allowed staging directory");
  const link = await lstat(resolve(worktree, reportedPath));
  if (link.isSymbolicLink() || !link.isFile()) throw new BrowserProofAdvisory("Browser proof source must be a regular file");
  let handle;
  try {
    handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) throw new BrowserProofAdvisory("Browser proof source must be a non-empty regular file");
    if (stat.size > MAX_IMAGE_BYTES) throw new BrowserProofAdvisory("A browser proof image exceeds the 5 MiB limit");
    const bytes = Buffer.allocUnsafe(Math.min(stat.size + 1, MAX_IMAGE_BYTES + 1));
    let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (bytesRead === 0) break; offset += bytesRead; }
    if (offset > MAX_IMAGE_BYTES || (await handle.stat()).size > MAX_IMAGE_BYTES) throw new BrowserProofAdvisory("A browser proof image exceeds the 5 MiB limit");
    return bytes.subarray(0, offset);
  } catch (error) {
    if (error instanceof BrowserProofAdvisory) throw error;
    throw new BrowserProofAdvisory("Browser proof source could not be read safely");
  } finally { await handle?.close(); }
}

function stored(row: ArtifactRow): StoredArtifact { return { id: row.id, companyId: row.companyId, kind: row.kind, filename: row.filename, mimeType: row.mimeType, byteSize: row.byteSize, sha256: row.sha256, storagePath: row.storagePath, createdAt: row.createdAt }; }

function reusableManifestMatches(manifest: BrowserProofManifest, input: { taskId: string; companyId: string; developerExecutionId: string; resultCommit: string; resultTree: string }, evidence: BrowserProofInput, captures: z.infer<typeof captureSchema>[]): boolean {
  if (manifest.taskId !== input.taskId || manifest.companyId !== input.companyId || manifest.developerExecutionId !== input.developerExecutionId || manifest.resultCommit.toLowerCase() !== input.resultCommit.toLowerCase() || manifest.resultTree.toLowerCase() !== input.resultTree.toLowerCase() || manifest.summary !== (evidence.summary?.trim() || null) || manifest.images.length !== captures.length) return false;
  return captures.every((capture, ordinal) => {
    const image = manifest.images[ordinal];
    if (!image) return false;
    const extension = image.mimeType === "image/png" ? "png" : image.mimeType === "image/jpeg" ? "jpg" : "webp";
    const viewport = capture.viewport ? { width: capture.viewport.width, height: capture.viewport.height, deviceScaleFactor: capture.viewport.deviceScaleFactor ?? null } : null;
    return image.filename === safeFilename(capture.path, ordinal, extension) && image.caption === (capture.caption?.trim() || null) && JSON.stringify(image.viewport) === JSON.stringify(viewport) && image.capturedAt === (capture.capturedAt ?? null);
  });
}

async function putOrVerify(database: ForgeDatabase, artifacts: ArtifactStore, input: { id: string; companyId: string; taskId: string; kind: string; filename: string; mimeType: string; bytes: Buffer }): Promise<StoredArtifact> {
  const lookup = (): ArtifactRow | undefined => database.authQuery((db) => db.prepare(`SELECT ${rowSelect} FROM forge_artifacts WHERE id = ?`).get(input.id) as ArtifactRow | undefined);
  const verify = (row: ArtifactRow): StoredArtifact => {
    if (row.companyId !== input.companyId || row.taskId !== input.taskId || row.kind !== input.kind || row.filename !== input.filename || row.mimeType !== input.mimeType || row.byteSize !== input.bytes.length || row.sha256 !== sha256(input.bytes)) throw new BrowserProofFailure("proof-identity-conflict", "Browser proof identity is already bound to different content");
    return stored(row);
  };
  const existing = lookup();
  if (existing) return verify(existing);
  try { return await artifacts.putArtifact(input.companyId, input.kind, { filename: input.filename, mimeType: input.mimeType, bytes: input.bytes, taskId: input.taskId }, input.id); }
  catch (error) { const raced = lookup(); if (raced) return verify(raced); throw error; }
}

export class BrowserProofService {
  constructor(private readonly database: ForgeDatabase, private readonly artifacts: ArtifactStore) {}

  async ingest(input: { taskId: string; companyId: string; developerExecutionId: string; resultCommit: string; resultTree: string; worktreePath: string; control: "off" | "capture" | "required"; evidence?: BrowserProofInput; onAdvisory?: (note: string) => void }): Promise<DurableBrowserProof | undefined> {
    if (input.control === "off") return undefined;
    const evidence = input.evidence ? BrowserProofInputSchema.parse(input.evidence) : undefined;
    let captures: z.infer<typeof captureSchema>[];
    try { captures = evidence ? normalizedCaptures(evidence) : []; }
    catch (error) {
      if (!(error instanceof BrowserProofAdvisory)) throw error;
      input.onAdvisory?.(error.message);
      return undefined;
    }
    const eligibleCaptures: z.infer<typeof captureSchema>[] = [];
    for (const capture of captures) {
      if (!imageType(capture.path)) input.onAdvisory?.(`Skipped ${capture.path}: unsupported screenshot extension.`);
      else if (eligibleCaptures.length >= MAX_IMAGES) input.onAdvisory?.(`Skipped ${capture.path}: at most ${MAX_IMAGES} screenshots can be attached.`);
      else eligibleCaptures.push(capture);
    }
    if (!eligibleCaptures.length) {
      if (input.control === "required") input.onAdvisory?.("No supported screenshots were attached.");
      return undefined;
    }
    const manifestId = deterministicId("proof_manifest", [1, input.companyId, input.taskId, input.developerExecutionId, input.resultCommit.toLowerCase()]);
    const existing = await this.loadManifestArtifact(manifestId, input.taskId, input.companyId);
    if (existing) {
      await this.verify(existing.manifest, manifestId);
      if (!reusableManifestMatches(existing.manifest, input, evidence!, eligibleCaptures)) throw new BrowserProofFailure("proof-identity-conflict", "Browser proof identity is already bound to different content");
      return { captured: true, manifestArtifactId: manifestId, artifactIds: existing.manifest.images.map((image) => image.artifactId), ...(existing.manifest.summary ? { summary: existing.manifest.summary } : {}) };
    }
    try { await this.assertUntracked(input.worktreePath, eligibleCaptures.map((capture) => capture.path)); }
    catch (error) {
      if (!(error instanceof BrowserProofAdvisory)) throw error;
      input.onAdvisory?.(error.message);
      return undefined;
    }
    let total = 0;
    const images: BrowserProofManifest["images"] = [];
    for (const [ordinal, capture] of eligibleCaptures.entries()) {
      let bytes: Buffer;
      try { bytes = await readCapture(input.worktreePath, capture.path); }
      catch (error) {
        if (!(error instanceof BrowserProofAdvisory)) throw error;
        input.onAdvisory?.(`Skipped ${capture.path}: ${error.message}`);
        continue;
      }
      if (total + bytes.length > MAX_TOTAL_BYTES) {
        input.onAdvisory?.(`Skipped ${capture.path}: the 25 MiB screenshot limit was reached.`);
        continue;
      }
      total += bytes.length;
      const type = imageType(capture.path)!;
      const contentHash = sha256(bytes), filename = safeFilename(capture.path, ordinal, type.extension);
      const id = deterministicId("proof_image", [1, input.companyId, input.taskId, input.developerExecutionId, input.resultCommit.toLowerCase(), ordinal, capture.path, contentHash]);
      const artifact = await putOrVerify(this.database, this.artifacts, { id, companyId: input.companyId, taskId: input.taskId, kind: "browser-proof-image", filename, mimeType: type.mimeType, bytes });
      images.push({ artifactId: artifact.id, sha256: artifact.sha256, filename, mimeType: type.mimeType, byteSize: artifact.byteSize, caption: capture.caption?.trim() || null, viewport: capture.viewport ? { width: capture.viewport.width, height: capture.viewport.height, deviceScaleFactor: capture.viewport.deviceScaleFactor ?? null } : null, capturedAt: capture.capturedAt ?? null });
    }
    if (!images.length) return undefined;
    const comparable = { version: 1 as const, taskId: input.taskId, companyId: input.companyId, developerExecutionId: input.developerExecutionId, resultCommit: input.resultCommit.toLowerCase(), resultTree: input.resultTree.toLowerCase(), summary: evidence?.summary?.trim() || null, images };
    const manifest: BrowserProofManifest = { ...comparable, createdAt: new Date().toISOString() };
    await putOrVerify(this.database, this.artifacts, { id: manifestId, companyId: input.companyId, taskId: input.taskId, kind: "browser-proof-manifest", filename: `${input.developerExecutionId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96) || "developer"}-browser-proof.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(manifest), "utf8") });
    const persisted = await this.loadManifestArtifact(manifestId, input.taskId, input.companyId);
    if (!persisted) throw new Error("Browser proof manifest failed persistence verification");
    await this.verify(persisted.manifest, manifestId);
    return { captured: true, manifestArtifactId: manifestId, artifactIds: images.map((image) => image.artifactId), ...(comparable.summary ? { summary: comparable.summary } : {}) };
  }

  async assertReportedProofUntracked(worktreePath: string, paths: string[]): Promise<void> {
    await this.assertUntracked(worktreePath, paths.map(normalizeBrowserProofPath));
  }

  async cleanupPersisted(worktreePath: string, evidence: BrowserProofInput, durable: DurableBrowserProof): Promise<void> {
    const persistedFilenames = new Set(durable.artifactIds.flatMap((artifactId) => {
      const row = this.database.authQuery((db) => db.prepare("SELECT filename FROM forge_artifacts WHERE id = ? AND kind = 'browser-proof-image'").get(artifactId) as { filename: string } | undefined);
      return row ? [row.filename] : [];
    }));
    const captures = normalizedCaptures(evidence).filter((capture) => imageType(capture.path)).slice(0, MAX_IMAGES);
    const worktree = await realpath(worktreePath), proofRoot = await realpath(resolve(worktree, ".forge-proof"));
    if (!inside(worktree, proofRoot) || relative(worktree, proofRoot) !== ".forge-proof") throw new Error("Browser proof staging directory is unsafe to clean");
    for (const [ordinal, capture] of captures.entries()) {
      const type = imageType(capture.path)!;
      if (!persistedFilenames.has(safeFilename(capture.path, ordinal, type.extension))) continue;
      const reported = resolve(worktree, capture.path), source = await realpath(reported), link = await lstat(reported);
      if (!inside(proofRoot, source) || link.isSymbolicLink() || !link.isFile()) throw new Error("Browser proof source is unsafe to clean");
      await unlink(source);
      let parent = dirname(source);
      while (parent !== proofRoot && inside(proofRoot, parent)) { try { await rmdir(parent); } catch { break; } parent = dirname(parent); }
    }
  }

  async verifyDurableReference(input: { taskId: string; companyId: string; developerExecutionId: string; resultCommit: string; resultTree: string; manifestArtifactId: string }): Promise<boolean> {
    const loaded = await this.loadManifestArtifact(input.manifestArtifactId, input.taskId, input.companyId);
    if (!loaded) return false;
    const manifest = loaded.manifest;
    if (manifest.developerExecutionId !== input.developerExecutionId || manifest.resultCommit.toLowerCase() !== input.resultCommit.toLowerCase() || manifest.resultTree.toLowerCase() !== input.resultTree.toLowerCase()) return false;
    try { await this.verify(manifest, input.manifestArtifactId); return true; } catch { return false; }
  }

  async project(taskId: string, companyId: string): Promise<BrowserProofProjection[]> {
    const ids = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_artifacts WHERE task_id = ? AND company_id = ? AND kind = 'browser-proof-manifest' ORDER BY created_at DESC, id DESC").all(taskId, companyId) as Array<{ id: string }>);
    const projected: BrowserProofProjection[] = [];
    for (const { id } of ids) { const loaded = await this.loadManifestArtifact(id, taskId, companyId); if (loaded) try { await this.verify(loaded.manifest, id); projected.push({ ...loaded.manifest, manifestArtifactId: id }); } catch { /* Invalid manifests are not durable proof. */ } }
    return projected;
  }

  projectSync(taskId: string, companyId: string): BrowserProofProjection[] {
    const rows = this.database.authQuery((db) => db.prepare(`SELECT ${rowSelect} FROM forge_artifacts WHERE task_id = ? AND company_id = ? AND kind = 'browser-proof-manifest' ORDER BY created_at DESC, id DESC`).all(taskId, companyId) as ArtifactRow[]);
    const projected: BrowserProofProjection[] = [];
    for (const artifact of rows) {
      try {
        const bytes = this.artifacts.getArtifactSync(stored(artifact));
        if (sha256(bytes) !== artifact.sha256) continue;
        const manifest = BrowserProofManifestSchema.parse(jsonRequired(bytes.toString("utf8")));
        if (manifest.taskId !== taskId || manifest.companyId !== companyId || !this.verifyRowsSync(manifest)) continue;
        projected.push({ ...manifest, manifestArtifactId: artifact.id });
      } catch { /* Invalid manifests are not durable proof. */ }
    }
    return projected;
  }

  readForDownload(taskId: string, companyId: string, artifactId: string): BrowserProofDownload | undefined {
    const row = this.database.authQuery((db) => db.prepare(`SELECT ${rowSelect} FROM forge_artifacts WHERE id = ? AND task_id = ? AND company_id = ? AND kind IN ('browser-proof-image', 'browser-proof-manifest')`).get(artifactId, taskId, companyId) as ArtifactRow | undefined);
    if (!row) return undefined;
    const bytes = this.artifacts.getArtifactSync(stored(row));
    if (sha256(bytes) !== row.sha256) throw new Error("Browser proof content failed integrity verification");
    if (row.kind === "browser-proof-manifest") {
      const manifest = BrowserProofManifestSchema.parse(jsonRequired(bytes.toString("utf8")));
      if (manifest.taskId !== taskId || manifest.companyId !== companyId || !this.verifyRowsSync(manifest)) throw new Error("Browser proof manifest failed integrity verification");
    } else {
      if (!imageType(row.filename) || imageType(row.filename)?.mimeType !== row.mimeType) throw new Error("Browser proof content failed integrity verification");
      const manifests = this.projectSync(taskId, companyId);
      if (!manifests.some((manifest) => manifest.images.some((image) => image.artifactId === artifactId && image.sha256 === row.sha256))) throw new Error("Browser proof content is not linked to a valid manifest");
    }
    return { kind: row.kind as BrowserProofDownload["kind"], filename: row.filename, mimeType: row.mimeType, bytes };
  }

  private async loadManifestArtifact(id: string, taskId: string, companyId: string): Promise<{ artifact: ArtifactRow; manifest: BrowserProofManifest } | undefined> {
    const artifact = this.database.authQuery((db) => db.prepare(`SELECT ${rowSelect} FROM forge_artifacts WHERE id = ? AND task_id = ? AND company_id = ? AND kind = 'browser-proof-manifest'`).get(id, taskId, companyId) as ArtifactRow | undefined);
    if (!artifact) return undefined;
    try { const bytes = await this.artifacts.getArtifact(stored(artifact)); if (sha256(bytes) !== artifact.sha256) return undefined; const manifest = BrowserProofManifestSchema.parse(jsonRequired(bytes.toString("utf8"))); if (manifest.taskId !== taskId || manifest.companyId !== companyId) return undefined; return { artifact, manifest }; } catch { return undefined; }
  }

  private async verify(manifest: BrowserProofManifest, manifestArtifactId: string): Promise<void> {
    if (!manifest.images.length) throw new Error("Browser proof manifest is empty");
    for (const image of manifest.images) {
      const row = this.database.authQuery((db) => db.prepare(`SELECT ${rowSelect} FROM forge_artifacts WHERE id = ? AND task_id = ? AND company_id = ? AND kind = 'browser-proof-image'`).get(image.artifactId, manifest.taskId, manifest.companyId) as ArtifactRow | undefined);
      if (!row || row.sha256 !== image.sha256 || row.filename !== image.filename || row.mimeType !== image.mimeType || row.byteSize !== image.byteSize) throw new Error("Browser proof manifest references unavailable content");
      const bytes = await this.artifacts.getArtifact(stored(row));
      if (sha256(bytes) !== row.sha256 || imageType(row.filename)?.mimeType !== row.mimeType) throw new Error("Browser proof content failed integrity verification");
    }
    void manifestArtifactId;
  }

  private verifyRowsSync(manifest: BrowserProofManifest): boolean {
    for (const image of manifest.images) {
      const row = this.database.authQuery((db) => db.prepare(`SELECT ${rowSelect} FROM forge_artifacts WHERE id = ? AND task_id = ? AND company_id = ? AND kind = 'browser-proof-image'`).get(image.artifactId, manifest.taskId, manifest.companyId) as ArtifactRow | undefined);
      if (!row || row.sha256 !== image.sha256 || row.filename !== image.filename || row.mimeType !== image.mimeType || row.byteSize !== image.byteSize) return false;
      try { const bytes = this.artifacts.getArtifactSync(stored(row)); if (sha256(bytes) !== row.sha256 || imageType(row.filename)?.mimeType !== row.mimeType) return false; } catch { return false; }
    }
    return manifest.images.length > 0;
  }

  private async assertUntracked(worktreePath: string, paths: string[]): Promise<void> {
    if (!paths.length) return;
    const repository = await runCommand({ taskId: null, stepId: null, command: "git", args: ["rev-parse", "--is-inside-work-tree"], cwd: worktreePath, timeout: 8_000 });
    if (repository.exitCode !== 0 || repository.stdout.trim() !== "true") throw new BrowserProofAdvisory("Browser proof Git boundary could not be verified");
    for (const path of paths) {
      const indexed = await runCommand({ taskId: null, stepId: null, expectNonZero: true, command: "git", args: ["ls-files", "--error-unmatch", "--", path], cwd: worktreePath, timeout: 8_000 });
      const inHead = await runCommand({ taskId: null, stepId: null, expectNonZero: true, command: "git", args: ["cat-file", "-e", `HEAD:${path}`], cwd: worktreePath, timeout: 8_000 });
      if (indexed.exitCode !== 0 && indexed.exitCode !== 1) throw new BrowserProofAdvisory("Browser proof Git boundary could not be verified");
      if (indexed.exitCode === 0 || inHead.exitCode === 0) throw new BrowserProofAdvisory("Browser proof must not be staged, tracked, or committed");
    }
  }
}
