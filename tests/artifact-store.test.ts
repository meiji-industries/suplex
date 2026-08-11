import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { CompanyArtifactStore } from "../src/artifact-store.js";

test("stores artifacts below a validated company root", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-artifacts-test-"));
  try {
    const store = new CompanyArtifactStore(root);
    const filename = await store.put("company-a", "reports/summary.txt", "safe");
    assert.equal(await store.read("company-a", "reports/summary.txt").then((contents) => contents.toString()), "safe");
    assert.equal(filename, join(root, "company-a", "reports", "summary.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects path traversal and path-like company identifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-artifacts-validation-test-"));
  try {
    const store = new CompanyArtifactStore(root);
    await assert.rejects(() => store.put("../outside", "file.txt", "unsafe"));
    await assert.rejects(() => store.put("company-a", "../company-b/file.txt", "unsafe"));
    await assert.rejects(() => store.put("company-a", "/tmp/file.txt", "unsafe"));
    await assert.rejects(() => store.put("company-a", "..\\outside.txt", "unsafe"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symlink traversal across company boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-artifacts-symlink-test-"));
  const outside = await mkdtemp(join(tmpdir(), "forge-artifacts-outside-"));
  try {
    const store = new CompanyArtifactStore(root);
    const companyRoot = await store.ensureCompanyRoot("company-a");
    await symlink(outside, join(companyRoot, "linked"));
    await assert.rejects(() => store.put("company-a", "linked/escape.txt", "unsafe"));

    await mkdir(join(outside, "company-b"));
    await symlink(join(outside, "company-b"), join(root, "company-b"));
    await assert.rejects(() => store.ensureCompanyRoot("company-b"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
