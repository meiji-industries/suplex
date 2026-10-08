import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { TaskSchema } from "../contracts/tasks.js";

describe("task response fixture", () => {
  it("is accepted by the test-side Zod validator", () => {
    const raw: unknown = JSON.parse(readFileSync(new URL("../../../tests/fixtures/task-response.json", import.meta.url), "utf8"));
    const parsed = TaskSchema.parse(raw);
    expect(parsed.status).toBe("queued");
    expect(parsed.queue.waitingOn[0]?.reason).toBe("prerequisite_running");
  });
});
