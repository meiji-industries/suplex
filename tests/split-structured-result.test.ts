import { expect, test } from "vitest";

import { splitStructuredResult } from "../src/frontend/lib/task-chat.js";

test("an agent message that echoes its result file splits into prose and result", () => {
  const text = 'Review complete. The result file is written.\n\n{"kind":"delivery_review","summary":"Approved."}';
  expect(splitStructuredResult(text)).toEqual({ prose: "Review complete. The result file is written.", result: '{"kind":"delivery_review","summary":"Approved."}' });
  expect(splitStructuredResult('{"kind":"delivery","summary":"Done."}')).toEqual({ prose: "", result: '{"kind":"delivery","summary":"Done."}' });
  expect(splitStructuredResult("Plain progress text.")).toEqual({ prose: "Plain progress text.", result: undefined });
});
