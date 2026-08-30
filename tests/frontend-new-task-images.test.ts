import { expect, test } from "vitest";

import { newTaskImageError } from "../src/frontend/components/app/new-task-images.js";

function png(size: number): File {
  return new File([new Uint8Array(size)], "note.png", { type: "image/png" });
}

test("rejects more than eight images", () => {
  const files = Array.from({ length: 8 }, () => png(10));
  expect(newTaskImageError(1, files)).toBe("At most eight images may be attached");
  expect(newTaskImageError(0, files.slice(0, 7))).toBe("");
});

test("rejects an unsupported image type", () => {
  const file = new File([new Uint8Array(10)], "note.svg", { type: "image/svg+xml" });
  expect(newTaskImageError(0, [file])).toBe("Only PNG, JPEG, WebP, and GIF images are accepted");
});

test("rejects a file larger than 8 MiB", () => {
  expect(newTaskImageError(0, [png(9_000_000)])).toBe("Each image must be smaller than 8 MB");
});

test("accepts a small PNG", () => {
  expect(newTaskImageError(0, [png(1_000)])).toBe("");
});
