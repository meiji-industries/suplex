import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { mkdir, open, realpath, rename, rm, lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { CompanyIdSchema } from "./schemas.js";
import { z } from "zod";

export interface ArtifactInput {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

export interface StoredArtifact {
  id: string;
  companyId: string;
  kind: "task-brief" | "task-image" | "agent-evidence" | "lead-plan" | "decision-blocker" | "supplemental-review" | "plan-decision" | "developer-delivery" | "delivery-review" | "delivery-repair-plan" | "developer-repair" | "delivery-blocker" | "delivery-decision" | "ci-evidence" | "ci-repair-plan" | "ci-repair-evidence" | "merge-conflict-evidence" | "merge-conflict-plan" | "merge-conflict-resolution" | "release-public-body" | "forward-merge-conflict" | "forward-merge-verification" | "forward-merge-delivery";
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  storagePath: string;
  createdAt: string;
}

export const ArtifactManifestEntrySchema = z.object({
  id: z.string().min(1).max(256),
  kind: z.enum(["task-brief", "task-image", "agent-evidence", "lead-plan", "decision-blocker", "supplemental-review", "plan-decision", "developer-delivery", "delivery-review", "delivery-repair-plan", "developer-repair", "delivery-blocker", "delivery-decision", "ci-evidence", "ci-repair-plan", "ci-repair-evidence", "merge-conflict-evidence", "merge-conflict-plan", "merge-conflict-resolution", "release-public-body", "forward-merge-conflict", "forward-merge-verification", "forward-merge-delivery"]),
  filename: z.string().min(1).max(160),
  mimeType: z.string().min(1).max(120),
  byteSize: z.number().int().positive().max(8 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  storagePath: z.string().min(1).max(1_000),
});

export type ArtifactManifestEntry = z.infer<typeof ArtifactManifestEntrySchema>;

export interface PlannedArtifact extends ArtifactManifestEntry {
  companyId: string;
  stagingPath: string;
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

interface FileIdentity { dev: number; ino: number }

export type ArtifactFaultPoint = "before_write_open" | "before_rename" | "after_read_open" | "before_remove";

export interface ArtifactStoreOptions {
  fault?: (point: ArtifactFaultPoint, paths: { companyId: string; storagePath: string; stagingPath?: string }) => void | Promise<void>;
}

async function directoryIdentity(path: string): Promise<FileIdentity> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ArtifactFailure("artifact-symlink", "Artifact directory is invalid");
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function directoryIdentitySync(path: string): FileIdentity {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ArtifactFailure("artifact-symlink", "Artifact directory is invalid");
  return { dev: stat.dev, ino: stat.ino };
}

export class ArtifactStore {
  constructor(private readonly root: string, private readonly options: ArtifactStoreOptions = {}) {}

  private async maybeFault(point: ArtifactFaultPoint, companyId: string, storagePath: string, stagingPath?: string): Promise<void> {
    await this.options.fault?.(point, { companyId, storagePath, ...(stagingPath ? { stagingPath } : {}) });
  }

  plan(companyId: string, intentId: string, kind: StoredArtifact["kind"], input: ArtifactInput): PlannedArtifact {
    const validatedCompanyId = CompanyIdSchema.parse(companyId);
    const filename = safeFilename(input.filename);
    if (!input.mimeType || input.mimeType.length > 120 || /[\r\n]/.test(input.mimeType)) throw new ArtifactFailure("invalid-mime-type", "Artifact type is invalid");
    if (input.bytes.length === 0 || input.bytes.length > 8 * 1024 * 1024) throw new ArtifactFailure("invalid-size", "Artifact size is invalid");
    const id = `artifact_${randomUUID().replaceAll("-", "")}`;
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const storagePath = join(validatedCompanyId, "objects", sha256.slice(0, 2), `${sha256}-${id}.bin`);
    const stagingPath = join(validatedCompanyId, ".staging", intentId, `${id}.tmp`);
    safeStoragePath(this.root, storagePath);
    safeStoragePath(this.root, stagingPath);
    return { id, companyId: validatedCompanyId, kind, filename, mimeType: input.mimeType, byteSize: input.bytes.length, sha256, storagePath, stagingPath };
  }

  async write(planned: PlannedArtifact, bytes: Buffer): Promise<StoredArtifact> {
    const manifest = ArtifactManifestEntrySchema.parse(planned);
    const companyId = CompanyIdSchema.parse(planned.companyId);
    if (!manifest.storagePath.startsWith(`${companyId}/objects/`) || !planned.stagingPath.startsWith(`${companyId}/.staging/`)) throw new ArtifactFailure("artifact-company-scope", "Artifact is outside the company root");
    if (bytes.length !== manifest.byteSize || createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) {
      throw new ArtifactFailure("hash-mismatch", "Artifact hash verification failed");
    }
    const absolutePath = safeStoragePath(this.root, manifest.storagePath);
    const temporaryPath = safeStoragePath(this.root, planned.stagingPath);
    await mkdir(resolve(this.root), { recursive: true, mode: 0o700 });
    const rootIdentity = await directoryIdentity(resolve(this.root));
    const companyRoot = resolve(this.root, companyId);
    const objectDirectory = resolve(this.root, manifest.storagePath.split("/").slice(0, 3).join("/"));
    const stagingDirectory = resolve(this.root, planned.stagingPath.split("/").slice(0, 3).join("/"));
    await rejectSymlinkComponents(this.root, companyRoot);
    await mkdir(companyRoot, { recursive: true, mode: 0o700 });
    await rejectSymlinkComponents(this.root, objectDirectory);
    await mkdir(objectDirectory, { recursive: true, mode: 0o700 });
    await rejectSymlinkComponents(this.root, stagingDirectory);
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    await rejectSymlinkComponents(this.root, companyRoot);
    await rejectSymlinkComponents(this.root, absolutePath);
    await rejectSymlinkComponents(this.root, temporaryPath);
    const companyIdentity = await directoryIdentity(companyRoot);
    const objectIdentity = await directoryIdentity(objectDirectory);
    const stagingIdentity = await directoryIdentity(stagingDirectory);
    let finalized = false;
    try {
      await this.maybeFault("before_write_open", companyId, manifest.storagePath, planned.stagingPath);
      if (!sameIdentity(rootIdentity, await directoryIdentity(resolve(this.root))) || !sameIdentity(companyIdentity, await directoryIdentity(companyRoot)) || !sameIdentity(objectIdentity, await directoryIdentity(objectDirectory)) || !sameIdentity(stagingIdentity, await directoryIdentity(stagingDirectory))) throw new ArtifactFailure("artifact-symlink", "Artifact directory changed during write");
      const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollowFlag(), 0o600);
      let written: Buffer;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== manifest.byteSize) throw new ArtifactFailure("artifact-corrupt", "Artifact content is unavailable");
        const readBuffer = Buffer.alloc(manifest.byteSize);
        let offset = 0;
        while (offset < readBuffer.length) {
          const result = await handle.read(readBuffer, offset, readBuffer.length - offset, offset);
          if (result.bytesRead === 0) break;
          offset += result.bytesRead;
        }
        written = readBuffer.subarray(0, offset);
      } finally {
        await handle.close();
      }
      if (createHash("sha256").update(written).digest("hex") !== manifest.sha256) throw new ArtifactFailure("hash-mismatch", "Artifact hash verification failed");
      if (!sameIdentity(companyIdentity, await directoryIdentity(companyRoot)) || !sameIdentity(objectIdentity, await directoryIdentity(objectDirectory)) || !sameIdentity(stagingIdentity, await directoryIdentity(stagingDirectory))) throw new ArtifactFailure("artifact-symlink", "Artifact directory changed during write");
      await this.maybeFault("before_rename", companyId, manifest.storagePath, planned.stagingPath);
      if (!sameIdentity(rootIdentity, await directoryIdentity(resolve(this.root))) || !sameIdentity(companyIdentity, await directoryIdentity(companyRoot)) || !sameIdentity(objectIdentity, await directoryIdentity(objectDirectory)) || !sameIdentity(stagingIdentity, await directoryIdentity(stagingDirectory))) throw new ArtifactFailure("artifact-symlink", "Artifact directory changed during write");
      await rename(temporaryPath, absolutePath);
      finalized = true;
      await rejectSymlinkComponents(this.root, absolutePath);
      const finalPath = await realpath(absolutePath);
      const finalHandle = await open(absolutePath, constants.O_RDONLY | noFollowFlag());
      try {
        const openedStat = await finalHandle.stat();
        const finalStat = await lstat(absolutePath);
        if (!openedStat.isFile() || !finalStat.isFile() || openedStat.dev !== finalStat.dev || openedStat.ino !== finalStat.ino) throw new ArtifactFailure("artifact-corrupt", "Artifact content is unavailable");
      } finally {
        await finalHandle.close();
      }
      const realCompanyRoot = await realpath(companyRoot);
      if (!within(realCompanyRoot, finalPath)) throw new ArtifactFailure("artifact-company-scope", "Artifact is outside the company root");
      if (!sameIdentity(rootIdentity, await directoryIdentity(resolve(this.root))) || !sameIdentity(companyIdentity, await directoryIdentity(companyRoot)) || !sameIdentity(objectIdentity, await directoryIdentity(objectDirectory)) || !sameIdentity(stagingIdentity, await directoryIdentity(stagingDirectory))) throw new ArtifactFailure("artifact-symlink", "Artifact directory changed during write");
    } catch (error) {
      const [rootStable, companyStable, objectStable, stagingStable] = await Promise.all([
        directoryIdentity(resolve(this.root)).then((value) => sameIdentity(rootIdentity, value)).catch(() => false),
        directoryIdentity(companyRoot).then((value) => sameIdentity(companyIdentity, value)).catch(() => false),
        directoryIdentity(objectDirectory).then((value) => sameIdentity(objectIdentity, value)).catch(() => false),
        directoryIdentity(stagingDirectory).then((value) => sameIdentity(stagingIdentity, value)).catch(() => false),
      ]);
      if (rootStable && companyStable && stagingStable) await rm(temporaryPath, { force: true });
      if (finalized && rootStable && companyStable && objectStable) await rm(absolutePath, { force: true });
      throw error;
    }
    return { id: manifest.id, companyId, kind: manifest.kind, filename: manifest.filename, mimeType: manifest.mimeType, byteSize: manifest.byteSize, sha256: manifest.sha256, storagePath: manifest.storagePath, createdAt: new Date().toISOString() };
  }

  async put(companyId: string, kind: StoredArtifact["kind"], input: ArtifactInput): Promise<StoredArtifact> {
    const planned = this.plan(companyId, `put_${randomUUID().replaceAll("-", "")}`, kind, input);
    return this.write(planned, input.bytes);
  }

  async removePlanned(planned: Pick<PlannedArtifact, "storagePath" | "stagingPath">): Promise<void> {
    const finalPath = safeStoragePath(this.root, planned.storagePath);
    const stagingPath = safeStoragePath(this.root, planned.stagingPath);
    await rejectSymlinkComponents(this.root, stagingPath);
    await rejectSymlinkComponents(this.root, finalPath);
    await rm(stagingPath, { force: true });
    await rm(finalPath, { force: true });
  }

  async read(artifact: Pick<StoredArtifact, "companyId" | "storagePath" | "sha256">): Promise<Buffer> {
    const companyId = CompanyIdSchema.parse(artifact.companyId);
    const absolutePath = safeStoragePath(this.root, artifact.storagePath);
    const companyRoot = resolve(this.root, companyId);
    if (!within(companyRoot, absolutePath)) throw new ArtifactFailure("artifact-company-scope", "Artifact is outside the company root");
    await rejectSymlinkComponents(this.root, absolutePath);
    const rootIdentity = await directoryIdentity(resolve(this.root));
    const companyIdentity = await directoryIdentity(companyRoot);
    const objectDirectory = dirname(absolutePath);
    const objectIdentity = await directoryIdentity(objectDirectory);
    const handle = await open(absolutePath, constants.O_RDONLY | noFollowFlag());
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ArtifactFailure("artifact-corrupt", "Artifact content is unavailable");
      await this.maybeFault("after_read_open", companyId, artifact.storagePath);
      bytes = await handle.readFile();
      const finalStat = await lstat(absolutePath);
      if (!finalStat.isFile() || finalStat.dev !== stat.dev || finalStat.ino !== stat.ino) throw new ArtifactFailure("artifact-corrupt", "Artifact content is unavailable");
    } finally {
      await handle.close();
    }
    const finalPath = await realpath(absolutePath);
    const realCompanyRoot = await realpath(companyRoot);
    if (!within(realCompanyRoot, finalPath)) throw new ArtifactFailure("artifact-company-scope", "Artifact is outside the company root");
    if (!sameIdentity(rootIdentity, await directoryIdentity(resolve(this.root))) || !sameIdentity(companyIdentity, await directoryIdentity(companyRoot)) || !sameIdentity(objectIdentity, await directoryIdentity(objectDirectory))) throw new ArtifactFailure("artifact-symlink", "Artifact directory changed during read");
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
    const rootIdentity = directoryIdentitySync(resolve(this.root));
    const companyIdentity = directoryIdentitySync(companyRoot);
    const objectDirectory = dirname(absolutePath);
    const objectIdentity = directoryIdentitySync(objectDirectory);
    const fd = openSync(absolutePath, constants.O_RDONLY | noFollowFlag());
    let bytes: Buffer;
    try {
      const openedStat = fstatSync(fd);
      const finalStat = lstatSync(absolutePath);
      if (!openedStat.isFile() || !finalStat.isFile() || openedStat.dev !== finalStat.dev || openedStat.ino !== finalStat.ino) throw new ArtifactFailure("artifact-corrupt", "Artifact content is unavailable");
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    if (!sameIdentity(rootIdentity, directoryIdentitySync(resolve(this.root))) || !sameIdentity(companyIdentity, directoryIdentitySync(companyRoot)) || !sameIdentity(objectIdentity, directoryIdentitySync(objectDirectory))) throw new ArtifactFailure("artifact-symlink", "Artifact directory changed during read");
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
    const rootIdentity = await directoryIdentity(resolve(this.root));
    const companyIdentity = await directoryIdentity(companyRoot);
    const objectDirectory = dirname(absolutePath);
    const objectIdentity = await directoryIdentity(objectDirectory);
    await this.maybeFault("before_remove", companyId, artifact.storagePath);
    await rejectSymlinkComponents(this.root, absolutePath);
    if (!sameIdentity(rootIdentity, await directoryIdentity(resolve(this.root))) || !sameIdentity(companyIdentity, await directoryIdentity(companyRoot)) || !sameIdentity(objectIdentity, await directoryIdentity(objectDirectory))) throw new ArtifactFailure("artifact-symlink", "Artifact directory changed during removal");
    await rm(absolutePath, { force: true });
  }
}
