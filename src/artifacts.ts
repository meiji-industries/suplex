import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { ForgeDatabase } from "./database.js";

export interface ArtifactInput { filename: string; mimeType: string; bytes: Buffer; taskId?: string }
export interface StoredArtifact { id: string; companyId: string; kind: string; filename: string; mimeType: string; byteSize: number; sha256: string; storagePath: string; createdAt: string }
export interface StagedArtifact extends StoredArtifact { ref: string }
export interface PlannedArtifact extends StoredArtifact { stagingPath: string }
export const ArtifactManifestEntrySchema = { parse<T>(value: T): T { return value } };
export class ArtifactFailure extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "ArtifactFailure" } }

function checked(root: string, companyId: string, path: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(companyId) || !path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new ArtifactFailure("artifact-traversal", "Artifact path is invalid");
  const company = resolve(root, companyId), target = resolve(root, path), rel = relative(company, target);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new ArtifactFailure("artifact-company-scope", "Artifact is outside the company root");
  return target;
}
function validate(companyId: string, kind: string, value: ArtifactInput) {
  if (!kind.trim() || !value.mimeType || /[\r\n]/.test(value.mimeType) || !value.bytes.length || value.bytes.length > 8 * 1024 * 1024 || basename(value.filename) !== value.filename || !value.filename.trim()) throw new ArtifactFailure("invalid-artifact", "Artifact input is invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(companyId)) throw new ArtifactFailure("invalid-company", "Artifact company is invalid");
}

/** Files are opaque; forge_artifacts is the one durable row for each file. */
export class ArtifactStore {
  constructor(private readonly root: string, private readonly database?: ForgeDatabase) {}
  async putArtifact(companyId: string, kind: string, value: ArtifactInput, id = `artifact_${randomUUID().replaceAll("-", "")}`): Promise<StoredArtifact> {
    validate(companyId, kind, value);
    const sha256 = createHash("sha256").update(value.bytes).digest("hex"), storagePath = `${companyId}/objects/${sha256.slice(0, 2)}/${id}.bin`, path = checked(this.root, companyId, storagePath), createdAt = new Date().toISOString();
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 }); await writeFile(path, value.bytes, { flag: "wx", mode: 0o600 });
    const artifact = { id, companyId, kind, filename: value.filename, mimeType: value.mimeType, byteSize: value.bytes.length, sha256, storagePath, createdAt };
    try { this.database?.authTransaction((db) => db.prepare("INSERT INTO forge_artifacts (id, company_id, task_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, companyId, value.taskId ?? "", kind, value.filename, value.mimeType, value.bytes.length, sha256, storagePath, createdAt)); }
    catch (error) { await rm(path, { force: true }); throw error; }
    return artifact;
  }
  async getArtifact(artifact: Pick<StoredArtifact, "companyId" | "storagePath"> & Partial<Pick<StoredArtifact, "sha256">>): Promise<Buffer> { return readFile(checked(this.root, artifact.companyId, artifact.storagePath)); }
  getArtifactSync(artifact: Pick<StoredArtifact, "companyId" | "storagePath"> & Partial<Pick<StoredArtifact, "sha256">>): Buffer { return readFileSync(checked(this.root, artifact.companyId, artifact.storagePath)); }
  async removeArtifact(artifact: Pick<StoredArtifact, "companyId" | "storagePath">): Promise<void> { await rm(checked(this.root, artifact.companyId, artifact.storagePath), { force: true }) }
  // Compatibility for persisted workflows; new production callers use put/getArtifact.
  put = this.putArtifact.bind(this); read = this.getArtifact.bind(this); readSync = this.getArtifactSync.bind(this); remove = this.removeArtifact.bind(this);
  async putWithId(companyId: string, id: string, kind: string, value: ArtifactInput) { return this.putArtifact(companyId, kind, value, id) }
  async stage(companyId: string, kind: string, value: ArtifactInput): Promise<StagedArtifact> { const ref = `staging_${randomUUID().replaceAll("-", "")}`, sha256 = createHash("sha256").update(value.bytes).digest("hex"), storagePath = `${companyId}/staging/${ref}.bin`; await mkdir(resolve(checked(this.root, companyId, storagePath), ".."), { recursive: true, mode: 0o700 }); await writeFile(checked(this.root, companyId, storagePath), value.bytes, { flag: "wx", mode: 0o600 }); return { ref, id: ref, companyId, kind, filename: value.filename, mimeType: value.mimeType, byteSize: value.bytes.length, sha256, storagePath, createdAt: new Date().toISOString() } }
  async readStaged(companyId: string, ref: string) { return this.getArtifact({ companyId, storagePath: `${companyId}/staging/${ref}.bin` }) }
  async discardStaged(artifact: Pick<StagedArtifact, "companyId" | "storagePath">) { return this.removeArtifact(artifact) }
  plan(companyId: string, _intent: string, kind: string, value: ArtifactInput, id = `artifact_${randomUUID().replaceAll("-", "")}`): PlannedArtifact { validate(companyId, kind, value); const sha256 = createHash("sha256").update(value.bytes).digest("hex"), storagePath = `${companyId}/objects/${sha256.slice(0, 2)}/${id}.bin`; return { id, companyId, kind, filename: value.filename, mimeType: value.mimeType, byteSize: value.bytes.length, sha256, storagePath, stagingPath: storagePath, createdAt: new Date().toISOString() } }
  async write(planned: PlannedArtifact, bytes: Buffer) { return this.putArtifact(planned.companyId, planned.kind, { filename: planned.filename, mimeType: planned.mimeType, bytes }, planned.id) }
  async removePlanned(planned: PlannedArtifact) { return this.removeArtifact(planned) }
}
