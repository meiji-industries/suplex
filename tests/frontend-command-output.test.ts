import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { CommandOutputBlock, stripAnsi } from "../src/frontend/components/app/command-output.js";

const now = new Date().toISOString();

test("shows a failed command's red stderr tail while collapsed and all output when expanded", () => {
  const output = { command: "gh pr create --draft", exitCode: 1, durationMs: 248, stdout: "opening pull request", stderr: "remote rejected\npermission denied", at: now };
  const collapsed = renderToStaticMarkup(createElement(CommandOutputBlock, { output }));
  const expanded = renderToStaticMarkup(createElement(CommandOutputBlock, { output, defaultExpanded: true }));

  expect(collapsed).toContain('aria-expanded="false"');
  expect(collapsed).toContain("permission denied");
  expect(collapsed).toContain("text-red-600");
  expect(collapsed).not.toContain("opening pull request</pre>");
  expect(expanded).toContain('aria-expanded="true"');
  expect(expanded).toContain("opening pull request");
  expect(expanded).toContain("permission denied");
});

test("shows a successful command's stdout tail and removes ANSI control sequences", () => {
  const output = { command: "git status", exitCode: 0, durationMs: 1_230, stdout: "first line\n\u001b[32mworking tree clean\u001b[0m", stderr: "", at: now };
  const html = renderToStaticMarkup(createElement(CommandOutputBlock, { output }));

  expect(html).toContain("working tree clean");
  expect(html).toContain("exit 0");
  expect(html).not.toContain("\u001b[");
  expect(stripAnsi("\u001b[31mfailed\u001b[0m")).toBe("failed");
});
