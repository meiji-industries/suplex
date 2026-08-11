import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
