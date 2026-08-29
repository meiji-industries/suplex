import { expect, test } from "vitest";
import { OpenRouterReadinessProbe } from "../src/agent-providers/openrouter-readiness.js";
import type { CommandRunner } from "../src/provider-readiness.js";

const runner = (version: string): CommandRunner => async () => ({ stdout: version, stderr: "" });
test("reports missing omp and a missing API key", async () => {
  const missing: CommandRunner = async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
  await expect(new OpenRouterReadinessProbe("omp", undefined, missing).check()).resolves.toMatchObject({ status: "unhealthy", details: { failure: "command-missing" } });
  await expect(new OpenRouterReadinessProbe("omp", undefined, runner("18.0.3")).check()).resolves.toMatchObject({ status: "unhealthy", summary: "OpenRouter API key is not configured", details: { failure: "key-missing" } });
});
test("rejects an unsupported omp version", async () => {
  await expect(new OpenRouterReadinessProbe("omp", undefined, runner("17.99.99")).check()).resolves.toMatchObject({ status: "unhealthy", details: { failure: "version-unsupported" } });
});
