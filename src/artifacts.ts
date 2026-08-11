import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

import { CompanyIdSchema } from "./schemas.js";

export interface ArtifactInput {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

export interface StoredArtifact {
  id: string;
  companyId: string;
  kind: "task-brief" | "task-image" | "agent-evidence" | "lead-plan" | "decision-blocker" | "supplemental-review" | "plan-decision" | "developer-delivery" | "delivery-review" | "developer-repair" | "delivery-decision" | "ci-evidence" | "merge-conflict-plan" | "merge-conflict-resolution";
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  storagePath: string;
  createdAt: string;
}

export class ArtifactFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArtifactFailure";
    this.code = code;
  }
}

function safeFilename(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed || basename(trimmed) !== trimmed || trimmed.includes("\\") || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ArtifactFailure("invalid-filename", "Artifact filename is invalid");
  }
  return trimmed.slice(0, 160);
}

function safeStoragePath(root: string, storagePath: string): string {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(root, storagePath);
  const path = relative(absoluteRoot, absolutePath);
  if (path.startsWith(`..${sep}`) || path === ".." || path.includes(`${sep}..${sep}`)) {
    throw new ArtifactFailure("artifact-traversal", "Artifact path is invalid");
  }
  return absolutePath;
}

export class ArtifactStore {
  constructor(private readonly root: string) {}

  async put(companyId: string, kind: StoredArtifact["kind"], input: ArtifactInput): Promise<StoredArtifact> {
    const validatedCompanyId = CompanyIdSchema.parse(companyId);
    const filename = safeFilename(input.filename);
    if (!input.mimeType || input.mimeType.length > 120 || /[\r\n]/.test(input.mimeType)) throw new ArtifactFailure("invalid-mime-type", "Artifact type is invalid");
    if (input.bytes.length === 0 || input.bytes.length > 8 * 1024 * 1024) throw new ArtifactFailure("invalid-size", "Artifact size is invalid");
    const id = `artifact_${randomUUID().replaceAll("-", "")}`;
    const storagePath = join(validatedCompanyId, `${id}.bin`);
    const absolutePath = safeStoragePath(this.root, storagePath);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
    await mkdir(resolve(this.root, validatedCompanyId), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporaryPath, input.bytes, { flag: "wx", mode: 0o600 });
      const written = await readFile(temporaryPath);
      if (createHash("sha256").update(written).digest("hex") !== sha256) throw new ArtifactFailure("hash-mismatch", "Artifact hash verification failed");
      await rename(temporaryPath, absolutePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    return { id, companyId, kind, filename, mimeType: input.mimeType, byteSize: input.bytes.length, sha256, storagePath, createdAt: new Date().toISOString() };
  }

  async read(artifact: Pick<StoredArtifact, "companyId" | "storagePath" | "sha256">): Promise<Buffer> {
    const companyId = CompanyIdSchema.parse(artifact.companyId);
    const absolutePath = safeStoragePath(this.root, artifact.storagePath);
    if (relative(resolve(this.root, companyId), absolutePath).startsWith(`..${sep}`)) throw new ArtifactFailure("artifact-company-scope", "Artifact is outside the company root");
    const bytes = await readFile(absolutePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== artifact.sha256) throw new ArtifactFailure("hash-mismatch", "Artifact hash verification failed");
    return bytes;
  }

  readSync(artifact: Pick<StoredArtifact, "companyId" | "storagePath" | "sha256">): Buffer {
    const companyId = CompanyIdSchema.parse(artifact.companyId);
    const absolutePath = safeStoragePath(this.root, artifact.storagePath);
    if (relative(resolve(this.root, companyId), absolutePath).startsWith(`..${sep}`)) throw new ArtifactFailure("artifact-company-scope", "Artifact is outside the company root");
    const bytes = readFileSync(absolutePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== artifact.sha256) throw new ArtifactFailure("hash-mismatch", "Artifact hash verification failed");
    return bytes;
  }
}
