import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm, writeFile, lstat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { CompanyIdSchema } from "./schemas.js";

export interface ArtifactInput {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

export interface StoredArtifact {
  id: string;
  companyId: string;
  kind: "task-brief" | "task-image" | "agent-evidence" | "lead-plan" | "decision-blocker" | "supplemental-review" | "plan-decision" | "developer-delivery" | "delivery-review" | "developer-repair" | "delivery-decision" | "ci-evidence" | "merge-conflict-evidence" | "merge-conflict-plan" | "merge-conflict-resolution";
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
  if (!storagePath || isAbsolute(storagePath) || storagePath.includes("\\")) {
    throw new ArtifactFailure("artifact-traversal", "Artifact path is invalid");
  }
  if (storagePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ArtifactFailure("artifact-traversal", "Artifact path is invalid");
  }
  const absolutePath = resolve(root, storagePath);
  const path = relative(absoluteRoot, absolutePath);
  if (path.startsWith(`..${sep}`) || path === ".." || path.includes(`${sep}..${sep}`) || path.split(sep).some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ArtifactFailure("artifact-traversal", "Artifact path is invalid");
  }
  return absolutePath;
}

function within(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function rejectSymlinkComponents(root: string, target: string): Promise<void> {
  if (!within(root, target)) throw new ArtifactFailure("artifact-company-scope", "Artifact is outside the company root");
  try {
    if ((await lstat(resolve(root))).isSymbolicLink()) throw new ArtifactFailure("artifact-symlink", "Artifact path cannot traverse a symbolic link");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const segments = relative(resolve(root), resolve(target)).split(sep).filter(Boolean);
  let current = resolve(root);
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new ArtifactFailure("artifact-symlink", "Artifact path cannot traverse a symbolic link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
  }
}

function rejectSymlinkComponentsSync(root: string, target: string): void {
  if (!within(root, target)) throw new ArtifactFailure("artifact-company-scope", "Artifact is outside the company root");
  try {
    if (lstatSync(resolve(root)).isSymbolicLink()) throw new ArtifactFailure("artifact-symlink", "Artifact path cannot traverse a symbolic link");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const segments = relative(resolve(root), resolve(target)).split(sep).filter(Boolean);
  let current = resolve(root);
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new ArtifactFailure("artifact-symlink", "Artifact path cannot traverse a symbolic link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
  }
}

function noFollowFlag(): number {
  return constants.O_NOFOLLOW ?? 0;
}

export class ArtifactStore {
  constructor(private readonly root: string) {}

  async put(companyId: string, kind: StoredArtifact["kind"], input: ArtifactInput): Promise<StoredArtifact> {
    const validatedCompanyId = CompanyIdSchema.parse(companyId);
    const filename = safeFilename(input.filename);
    if (!input.mimeType || input.mimeType.length > 120 || /[\r\n]/.test(input.mimeType)) throw new ArtifactFailure("invalid-mime-type", "Artifact type is invalid");
    if (input.bytes.length === 0 || input.bytes.length > 8 * 1024 * 1024) throw new ArtifactFailure("invalid-size", "Artifact size is invalid");
    const id = `artifact_${randomUUID().replaceAll("-", "")}`;
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const storagePath = join(validatedCompanyId, "objects", sha256.slice(0, 2), `${sha256}-${id}.bin`);
    const absolutePath = safeStoragePath(this.root, storagePath);
    const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
    await mkdir(resolve(this.root), { recursive: true, mode: 0o700 });
    await rejectSymlinkComponents(this.root, resolve(this.root, validatedCompanyId));
    await mkdir(resolve(this.root, validatedCompanyId), { recursive: true, mode: 0o700 });
    await rejectSymlinkComponents(this.root, resolve(this.root, validatedCompanyId));
    await rejectSymlinkComponents(this.root, resolve(this.root, validatedCompanyId, "objects"));
    await mkdir(resolve(this.root, validatedCompanyId, "objects"), { recursive: true, mode: 0o700 });
    await rejectSymlinkComponents(this.root, resolve(this.root, validatedCompanyId, "objects"));
    await rejectSymlinkComponents(this.root, resolve(this.root, validatedCompanyId, "objects", sha256.slice(0, 2)));
    await mkdir(resolve(this.root, validatedCompanyId, "objects", sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
    await rejectSymlinkComponents(this.root, resolve(this.root, validatedCompanyId, "objects", sha256.slice(0, 2)));
    await rejectSymlinkComponents(this.root, absolutePath);
    try {
      await writeFile(temporaryPath, input.bytes, { flag: "wx", mode: 0o600 });
      const written = await readFile(temporaryPath);
      if (createHash("sha256").update(written).digest("hex") !== sha256) throw new ArtifactFailure("hash-mismatch", "Artifact hash verification failed");
      await rename(temporaryPath, absolutePath);
      await rejectSymlinkComponents(this.root, absolutePath);
      const finalPath = await realpath(absolutePath);
      const realCompanyRoot = await realpath(resolve(this.root, validatedCompanyId));
      if (!within(realCompanyRoot, finalPath)) throw new ArtifactFailure("artifact-company-scope", "Artifact is outside the company root");
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    return { id, companyId, kind, filename, mimeType: input.mimeType, byteSize: input.bytes.length, sha256, storagePath, createdAt: new Date().toISOString() };
  }

  async read(artifact: Pick<StoredArtifact, "companyId" | "storagePath" | "sha256">): Promise<Buffer> {
    const companyId = CompanyIdSchema.parse(artifact.companyId);
    const absolutePath = safeStoragePath(this.root, artifact.storagePath);
    const companyRoot = resolve(this.root, companyId);
    if (!within(companyRoot, absolutePath)) throw new ArtifactFailure("artifact-company-scope", "Artifact is outside the company root");
    await rejectSymlinkComponents(this.root, absolutePath);
    const handle = await open(absolutePath, constants.O_RDONLY | noFollowFlag());
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ArtifactFailure("artifact-corrupt", "Artifact content is unavailable");
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== artifact.sha256) throw new ArtifactFailure("hash-mismatch", "Artifact hash verification failed");
    return bytes;
  }

  readSync(artifact: Pick<StoredArtifact, "companyId" | "storagePath" | "sha256">): Buffer {
    const companyId = CompanyIdSchema.parse(artifact.companyId);
    const absolutePath = safeStoragePath(this.root, artifact.storagePath);
    const companyRoot = resolve(this.root, companyId);
    if (!within(companyRoot, absolutePath)) throw new ArtifactFailure("artifact-company-scope", "Artifact is outside the company root");
    rejectSymlinkComponentsSync(this.root, absolutePath);
    const fd = openSync(absolutePath, constants.O_RDONLY | noFollowFlag());
    let bytes: Buffer;
    try {
      if (!fstatSync(fd).isFile()) throw new ArtifactFailure("artifact-corrupt", "Artifact content is unavailable");
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== artifact.sha256) throw new ArtifactFailure("hash-mismatch", "Artifact hash verification failed");
    return bytes;
  }

  async remove(artifact: Pick<StoredArtifact, "companyId" | "storagePath">): Promise<void> {
    const companyId = CompanyIdSchema.parse(artifact.companyId);
    const absolutePath = safeStoragePath(this.root, artifact.storagePath);
    const companyRoot = resolve(this.root, companyId);
    if (!within(companyRoot, absolutePath)) throw new ArtifactFailure("artifact-company-scope", "Artifact is outside the company root");
    await rejectSymlinkComponents(this.root, absolutePath);
    await rm(absolutePath, { force: true });
  }
}
