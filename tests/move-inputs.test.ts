import { describe, expect, it } from "vitest";

import { moveInputs } from "../src/frontend/features/moves/lib/move-inputs.js";

describe("moveInputs", () => {
  it("declares text and choice inputs once and ignores invalid placeholders", () => {
    expect(moveInputs("release:{{ bump: patch | minor |major }} {{notes}} {{bump}} {{notes: x}} {{Bad}} {{a:}} {{1x}}")).toEqual([
      { name: "bump", options: ["patch", "minor", "major"] },
      { name: "notes", options: ["x"] },
    ]);
  });
});
