import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ArtifactStore } from "../src/artifacts.js";

test("put/get preserves bytes within its company", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-artifacts-"));
  try { const store = new ArtifactStore(root); const artifact = await store.putArtifact("company_a", "evidence", { filename: "evidence.txt", mimeType: "text/plain", bytes: Buffer.from("private") }); await expect(store.getArtifact(artifact)).resolves.toEqual(Buffer.from("private")); }
  finally { await rm(root, { recursive: true, force: true }); }
});
