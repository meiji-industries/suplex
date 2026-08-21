import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

// proxyActivities() returns an opaque Proxy that hides the retry options it was
// built with, so the built proxies can't be introspected at runtime even though
// the module itself imports cleanly outside the workflow sandbox. A regex over
// the source is the honest way to pin "every proxy has a bounded retry policy".
const source = readFileSync(join(import.meta.dirname, "../src/temporal/workflow/activity-proxies.ts"), "utf8");

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
            const constBlock = source.match(new RegExp(`const ${ref![1]} = \\{[\\s\\S]*?\\};`));
            expect(constBlock, `no const named ${ref![1]}`).not.toBeNull();
            const constAttempts = constBlock![0].match(/maximumAttempts:\s*(\d+)/);
            expect(constAttempts, `${ref![1]} has no maximumAttempts`).not.toBeNull();
            return Number(constAttempts![1]);
          })();
      expect(attempts, `unbounded maximumAttempts in: ${call}`).toBeGreaterThan(0);
    }
  });
});
