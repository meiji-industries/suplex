import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { SuplexDatabase } from "./database.js";
import type Database from "better-sqlite3";

export interface ArtifactInput { filename: string; mimeType: string; bytes: Buffer; taskId?: string }
export interface StoredArtifact { id: string; companyId: string; kind: string; filename: string; mimeType: string; byteSize: number; sha256: string; storagePath: string; createdAt: string }
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

/** Files are opaque; suplex_artifacts is the one durable row for each file. */
export class ArtifactStore {
  constructor(private readonly root: string, private readonly database?: SuplexDatabase) {}
  async putArtifact(companyId: string, kind: string, value: ArtifactInput, id = `artifact_${randomUUID().replaceAll("-", "")}`): Promise<StoredArtifact> {
    validate(companyId, kind, value);
    const sha256 = createHash("sha256").update(value.bytes).digest("hex"), storagePath = `${companyId}/objects/${sha256.slice(0, 2)}/${id}.bin`, path = checked(this.root, companyId, storagePath), createdAt = new Date().toISOString();
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 }); await writeFile(path, value.bytes, { flag: "wx", mode: 0o600 });
    const artifact = { id, companyId, kind, filename: value.filename, mimeType: value.mimeType, byteSize: value.bytes.length, sha256, storagePath, createdAt };
    try { this.database?.authTransaction((db) => db.prepare("INSERT INTO suplex_artifacts (id, company_id, task_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, companyId, value.taskId ?? "", kind, value.filename, value.mimeType, value.bytes.length, sha256, storagePath, createdAt)); }
    catch (error) { await rm(path, { force: true }); throw error; }
    return artifact;
  }
  putArtifactSync(database: Database.Database, companyId: string, kind: string, value: ArtifactInput, id = `artifact_${randomUUID().replaceAll("-", "")}`): StoredArtifact {
    validate(companyId, kind, value);
    const sha256 = createHash("sha256").update(value.bytes).digest("hex"), storagePath = `${companyId}/objects/${sha256.slice(0, 2)}/${id}.bin`, path = checked(this.root, companyId, storagePath), createdAt = new Date().toISOString();
    mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 }); writeFileSync(path, value.bytes, { flag: "wx", mode: 0o600 });
    const artifact = { id, companyId, kind, filename: value.filename, mimeType: value.mimeType, byteSize: value.bytes.length, sha256, storagePath, createdAt };
    try { database.prepare("INSERT INTO suplex_artifacts (id, company_id, task_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, companyId, value.taskId ?? "", kind, value.filename, value.mimeType, value.bytes.length, sha256, storagePath, createdAt); }
    catch (error) { rmSync(path, { force: true }); throw error; }
    return artifact;
  }
  async getArtifact(artifact: Pick<StoredArtifact, "companyId" | "storagePath"> & Partial<Pick<StoredArtifact, "sha256">>): Promise<Buffer> { return readFile(checked(this.root, artifact.companyId, artifact.storagePath)); }
  async removeArtifact(artifact: Pick<StoredArtifact, "companyId" | "storagePath">): Promise<void> { await rm(checked(this.root, artifact.companyId, artifact.storagePath), { force: true }) }
}
