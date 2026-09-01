import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

// proxyActivities() returns an opaque Proxy that hides the retry options it was
// built with, so the built proxies can't be introspected at runtime even though
// the module itself imports cleanly outside the workflow sandbox. A regex over
// the source is the honest way to pin "every proxy has a bounded retry policy".
const source = readFileSync(join(import.meta.dirname, "../src/engine/workflow/activity-proxies.ts"), "utf8");

describe("activity proxies retry policies", () => {
  test("every proxyActivities call has a retry policy with a finite maximumAttempts", () => {
    const calls = source.match(/proxyActivities<[^>]+>\(\{[\s\S]*?\}\);/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, `no "retry" option in: ${call}`).toMatch(/retry:/);
      // Resolve `retry: SOME_CONST` references back to the const's own maximumAttempts.
      const inlineMatch = call.match(/maximumAttempts:\s*(\d+)/);
      const attempts = inlineMatch
        ? Number(inlineMatch[1])
        : (() => {
            const ref = call.match(/retry:\s*([A-Z_]+)/);
            expect(ref, `unrecognized retry policy shape in: ${call}`).not.toBeNull();
            const constBlock = source.match(new RegExp(`const ${ref![1]}(?:\\s*:\\s*[^=]+)?\\s*= \\{[\\s\\S]*?\\};`));
            expect(constBlock, `no const named ${ref![1]}`).not.toBeNull();
            const constAttempts = constBlock![0].match(/maximumAttempts:\s*(\d+)/);
            expect(constAttempts, `${ref![1]} has no maximumAttempts`).not.toBeNull();
            return Number(constAttempts![1]);
          })();
      expect(attempts, `unbounded maximumAttempts in: ${call}`).toBeGreaterThan(0);
    }
  });

  test("Herdr agent proxies use their matching start-to-close timeouts and retries", () => {
    const calls = source.match(/proxyActivities<[^>]+>\((herdr\w+ActivityCallOptions)\);/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const optionsName = call.match(/\((herdr\w+ActivityCallOptions)\)/)?.[1];
      expect(optionsName).toBeDefined();
      const options = source.match(new RegExp(`const ${optionsName}[^=]*= \\{[\\s\\S]*?\\};`))?.[0] ?? "";
      expect(options).toMatch(/retry:\s*(EXTERNAL_AGENT_RETRY_POLICY|SUPERVISED_DEVELOPER_RETRY_POLICY)/);
    }

    expect(source).toMatch(/herdrLeadActivityCallOptions[^=]*= \{ startToCloseTimeout: "20 minutes", retry: EXTERNAL_AGENT_RETRY_POLICY \}/);
    expect(source).toMatch(/herdrDeveloperActivityCallOptions[^=]*= \{ startToCloseTimeout: "60 minutes", retry: EXTERNAL_AGENT_RETRY_POLICY \}/);
    expect(source).toMatch(/herdrSupervisedDeveloperActivityCallOptions[^=]*= \{\s*\.\.\.herdrDeveloperActivityCallOptions,\s*retry: SUPERVISED_DEVELOPER_RETRY_POLICY,/);
  });
});
