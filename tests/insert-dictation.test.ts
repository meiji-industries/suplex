import { expect, test } from "vitest";
import { insertDictation } from "../src/frontend/features/tasks/use-dictation.js";

test("a dictated phrase goes at the caret with one space on each side", () => {
  expect(insertDictation("", "hello")).toEqual({ text: "hello", caret: 5 });
  expect(insertDictation("Fix bug", "the login")).toEqual({ text: "Fix bug the login", caret: 17 });
  expect(insertDictation("Fix bug", "the login", 3)).toEqual({ text: "Fix the login bug", caret: 13 });
  expect(insertDictation("Fix  bug", "the", 4)).toEqual({ text: "Fix the bug", caret: 7 });
  expect(insertDictation("Fix old bug", "new", 4, 7)).toEqual({ text: "Fix new bug", caret: 7 });
});
