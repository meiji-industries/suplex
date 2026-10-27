import { expect, test } from "vitest";

import { normalizeFilename, parseStack } from "../shell/exception-frames.js";

const origin = "https://host.example";

test("V8 and Gecko stacks give the same frames", () => {
  const v8 = `Error: x\n    at run (${origin}/assets/a.js:1:2)\n    at ${origin}/assets/b.js:3:4`;
  const gecko = `run@${origin}/assets/a.js:1:2\n@${origin}/assets/b.js:3:4`;
  const expected = [["run", "app://suplex/assets/a.js", 1, 2], ["<anonymous>", "app://suplex/assets/b.js", 3, 4]];
  for (const stack of [v8, gecko]) {
    expect(parseStack(stack, origin).map(frame => [frame.function, frame.filename, frame.lineno, frame.colno])).toEqual(expected);
  }
});

test("only this origin's script paths survive, without queries or IDs", () => {
  expect(normalizeFilename(`${origin}/assets/a.js?x=1#y`, origin)).toBe("app://suplex/assets/a.js");
  expect(normalizeFilename(`${origin}/features/tasks/view.tsx`, origin)).toBe("app://suplex/features/tasks/view.tsx");
  for (const url of ["https://other.example/assets/a.js", `${origin}/tasks/task_secret/a.js`, `${origin}/api/tasks`, `${origin}/@fs/Users/a/b.js`, "/assets/a.js", "/Users/a/b.js", "file:///Users/a/b.js", "not a url"]) {
    expect(normalizeFilename(url, origin)).toBeUndefined();
  }
  expect(parseStack(undefined, origin)).toEqual([]);
  expect(parseStack("Error: only a message with a.js:1:2", origin)).toEqual([]);
});

test("frames are bounded and function names stay identifiers", () => {
  const lines = Array.from({ length: 100 }, (_, index) => `    at fn${index} (${origin}/assets/a.js:${index}:1)`);
  expect(parseStack(lines.join("\n"), origin)).toHaveLength(30);
  const odd = parseStack(`    at user@example.com (${origin}/assets/a.js:1:1)`, origin);
  expect(odd[0]?.function).toBe("<anonymous>");
});
