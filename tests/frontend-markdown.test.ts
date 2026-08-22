import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { Markdown } from "../src/frontend/components/app/markdown.js";

describe("Markdown", () => {
  test("renders fenced code, formatting, and links", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { source: "Kate writes:\n\n```\nHi Adam,\n\nMany thanks!\nKate\n```\n\n**Bold** and _italic_ with [a link](https://example.com)." }));

    expect(html).toContain("<pre><code>Hi Adam,");
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noreferrer">a link</a>');
  });

  test("escapes raw HTML", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { source: "<script>alert('unsafe')</script>" }));

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
