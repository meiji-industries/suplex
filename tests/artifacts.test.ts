import { mkdir, mkdtemp, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";

test("requires company scope for every content read", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-artifact-scope-"));
  try {
    const store = new ArtifactStore(root);
    const artifact = await store.put("company-a", "agent-evidence", { filename: "evidence.md", mimeType: "text/markdown", bytes: Buffer.from("private") });
    await expect(store.read({ companyId: "company-a", storagePath: artifact.storagePath, sha256: artifact.sha256 })).resolves.toEqual(Buffer.from("private"));
    await expect(store.read({ companyId: "company-b", storagePath: artifact.storagePath, sha256: artifact.sha256 })).rejects.toMatchObject({ code: "artifact-company-scope" });
    await expect(store.put("../company-b", "agent-evidence", { filename: "evidence.md", mimeType: "text/markdown", bytes: Buffer.from("unsafe") })).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when an object directory is exchanged before rename", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-artifact-write-race-"));
  const outside = await mkdtemp(join(tmpdir(), "forge-artifact-write-race-outside-"));
  try {
    let swapped = false;
    const store = new ArtifactStore(root, { async fault(point, paths) {
      if (point !== "before_rename" || swapped) return;
      swapped = true;
      const objectDirectory = dirname(join(root, paths.storagePath));
      await rename(objectDirectory, `${objectDirectory}.original`);
      await symlink(outside, objectDirectory, "dir");
    } });
    const bytes = Buffer.from("race-safe");
    const planned = store.plan("company-race", "creation-race", "task-brief", { filename: "task.md", mimeType: "text/markdown", bytes });
    await expect(store.write(planned, bytes)).rejects.toMatchObject({ code: "artifact-symlink" });
    await expect(stat(join(root, planned.stagingPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("never returns bytes when the final file is exchanged after open", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-artifact-read-race-"));
  const outside = join(root, "outside.txt");
  try {
    const normal = new ArtifactStore(root);
    const artifact = await normal.put("company-read-race", "task-brief", { filename: "task.md", mimeType: "text/markdown", bytes: Buffer.from("trusted") });
    await writeFile(outside, "untrusted");
    let swapped = false;
    const racing = new ArtifactStore(root, { async fault(point, paths) {
      if (point !== "after_read_open" || swapped) return;
      swapped = true;
      const finalPath = join(root, paths.storagePath);
      await rename(finalPath, `${finalPath}.original`);
      await symlink(outside, finalPath);
    } });
    await expect(racing.read(artifact)).rejects.toMatchObject({ code: "artifact-corrupt" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a symlinked company directory before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-artifact-company-link-"));
  const outside = await mkdtemp(join(tmpdir(), "forge-artifact-company-link-outside-"));
  try {
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, "company-link"), "dir");
    const store = new ArtifactStore(root);
    const bytes = Buffer.from("safe");
    const planned = store.plan("company-link", "creation-link", "task-brief", { filename: "task.md", mimeType: "text/markdown", bytes });
    await expect(store.write(planned, bytes)).rejects.toMatchObject({ code: "artifact-symlink" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("INV-07/INV-08 idempotent Developer artifacts keep one stable object and reject conflicting bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-artifact-idempotent-"));
  try {
    const store = new ArtifactStore(root);
    const input = { filename: "developer.json", mimeType: "application/json", bytes: Buffer.from("{\"result\":\"stable\"}") };
    const [first, duplicate] = await Promise.all([
      store.putIdempotent("company-stable", "developer-delivery", "developer_0123456789abcdef01234567:delivery", input),
      store.putIdempotent("company-stable", "developer-delivery", "developer_0123456789abcdef01234567:delivery", input),
    ]);

    expect(duplicate).toMatchObject({ id: first.id, sha256: first.sha256, storagePath: first.storagePath });
    expect(await store.read(first)).toEqual(input.bytes);
    await expect(store.putIdempotent("company-stable", "developer-delivery", "developer_0123456789abcdef01234567:delivery", { ...input, bytes: Buffer.from("{\"result\":\"conflict\"}") })).rejects.toMatchObject({ code: "artifact-idempotency-conflict" });
    expect((await readdir(dirname(join(root, first.storagePath)))).filter((file) => file.includes(first.id))).toEqual([`${first.id}.bin`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
