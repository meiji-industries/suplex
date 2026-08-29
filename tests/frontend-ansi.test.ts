import { expect, test } from "vitest";

import { parseAnsi } from "../src/frontend/lib/ansi.js";

test("parseAnsi maps SGR codes to inline styles and drops non-SGR escapes", () => {
  expect(parseAnsi("a\x1b[1;38;2;1;2;3mb\x1b[0mc\x1b[38;5;2md\x1b[2me\x1b[22mf\x1b]0;title\x07g\x1b[2Kh")).toEqual([
    { text: "a", style: {} },
    { text: "b", style: { fontWeight: "bold", color: "rgb(1,2,3)" } },
    { text: "c", style: {} },
    { text: "d", style: { color: "#0dbc79" } },
    { text: "e", style: { color: "#0dbc79", opacity: "0.6" } },
    { text: "fgh", style: { color: "#0dbc79" } },
  ]);
});
