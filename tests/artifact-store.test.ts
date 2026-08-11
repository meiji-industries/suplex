import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { CompanyArtifactStore } from "../src/artifact-store.js";

test("stores artifacts below a validated company root", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-artifacts-test-"));
  try {
    const store = new CompanyArtifactStore(root);
    const filename = await store.put("company-a", "reports/summary.txt", "safe");
    expect(await store.read("company-a", "reports/summary.txt").then((contents) => contents.toString())).toBe("safe");
    expect(filename).toBe(join(root, "company-a", "reports", "summary.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps normal company roots and reads isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-artifacts-company-isolation-test-"));
  try {
    const store = new CompanyArtifactStore(root);
    await store.put("company-a", "report.txt", "a");
    await store.put("company-b", "report.txt", "b");
    expect(await store.read("company-a", "report.txt").then((contents) => contents.toString())).toBe("a");
    expect(await store.read("company-b", "report.txt").then((contents) => contents.toString())).toBe("b");
    await expect(store.read("company-a", "../company-b/report.txt")).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects path traversal and path-like company identifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-artifacts-validation-test-"));
  try {
    const store = new CompanyArtifactStore(root);
    await expect(store.put("../outside", "file.txt", "unsafe")).rejects.toThrow();
    await expect(store.put("company-a", "../company-b/file.txt", "unsafe")).rejects.toThrow();
    await expect(store.put("company-a", "/tmp/file.txt", "unsafe")).rejects.toThrow();
    await expect(store.put("company-a", "..\\outside.txt", "unsafe")).rejects.toThrow();
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
    await expect(store.put("company-a", "linked/escape.txt", "unsafe")).rejects.toThrow();

    await mkdir(join(outside, "company-b"));
    await symlink(join(outside, "company-b"), join(root, "company-b"));
    await expect(store.ensureCompanyRoot("company-b")).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
