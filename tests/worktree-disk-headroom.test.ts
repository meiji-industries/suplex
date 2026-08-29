import { describe, expect, it, afterEach } from "vitest";
import { assertWorktreeDiskHeadroom, WorktreeFailure } from "../src/worktrees.js";

const gb = 1024 * 1024 * 1024;

function fakeStatfs(freeBytes: number) {
  return async () => ({ bavail: freeBytes / 4096, bsize: 4096 }) as any;
}

describe("assertWorktreeDiskHeadroom", () => {
  const originalEnv = process.env.FORGE_MIN_FREE_DISK_GB;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.FORGE_MIN_FREE_DISK_GB;
    else process.env.FORGE_MIN_FREE_DISK_GB = originalEnv;
  });

  it("throws a non-retryable host_capacity failure below the default 5 GB threshold", async () => {
    delete process.env.FORGE_MIN_FREE_DISK_GB;
    const statfsFn = fakeStatfs(3.2 * gb);
    await expect(assertWorktreeDiskHeadroom("/Users/dev/forge/worktrees", statfsFn)).rejects.toMatchObject({
      code: "host_capacity",
      message: expect.stringContaining("/Users/dev/forge/worktrees"),
    });
    try {
      await assertWorktreeDiskHeadroom("/Users/dev/forge/worktrees", statfsFn);
    } catch (error) {
      expect(error).toBeInstanceOf(WorktreeFailure);
      expect((error as WorktreeFailure).message).toContain("Free disk below 5 GB on /Users/dev/forge/worktrees");
      expect((error as WorktreeFailure).message).toContain("3.2 GB available");
    }
  });

  it("passes when free space is at or above the threshold", async () => {
    delete process.env.FORGE_MIN_FREE_DISK_GB;
    await expect(assertWorktreeDiskHeadroom("/some/root", fakeStatfs(5 * gb))).resolves.toBeUndefined();
    await expect(assertWorktreeDiskHeadroom("/some/root", fakeStatfs(20 * gb))).resolves.toBeUndefined();
  });

  it("respects the FORGE_MIN_FREE_DISK_GB override", async () => {
    process.env.FORGE_MIN_FREE_DISK_GB = "1";
    await expect(assertWorktreeDiskHeadroom("/some/root", fakeStatfs(3.2 * gb))).resolves.toBeUndefined();
    await expect(assertWorktreeDiskHeadroom("/some/root", fakeStatfs(0.5 * gb))).rejects.toMatchObject({ code: "host_capacity" });
  });

  it("uses the configured threshold when the environment override is absent or invalid", async () => {
    for (const invalid of ["abc", "-5", ""]) {
      process.env.FORGE_MIN_FREE_DISK_GB = invalid;
      await expect(assertWorktreeDiskHeadroom("/some/root", fakeStatfs(9 * gb), 10)).rejects.toMatchObject({ code: "host_capacity" });
      await expect(assertWorktreeDiskHeadroom("/some/root", fakeStatfs(11 * gb), 10)).resolves.toBeUndefined();
    }
  });
});
