import { expect, test } from "vitest";
import { documentTitle } from "../src/frontend/views/attention.js";

test("attention count supplies the desktop document title", () => {
  expect(documentTitle(0)).toBe("Forge");
  expect(documentTitle(3)).toBe("(3) Forge");
});
