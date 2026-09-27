/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
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

  test("retains link focus and image DOM during message updates and refreshes mapped images", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const source = '[A link](https://example.com "Title")\n\n![Screenshot](image.png)';
    const imageSources = { "image.png": "/api/images/first" };
    try {
      await act(async () => root.render(createElement(Markdown, { source, imageSources })));
      const link = container.querySelector("a")!;
      const image = container.querySelector("img")!;
      link.focus();
      expect(image.getAttribute("src")).toBe("/api/images/first");
      expect(link.title).toBe("Title");

      for (const nextSource of [source, `${source}\n\nMore content`]) {
        await act(async () => root.render(createElement(Markdown, { source: nextSource, imageSources })));
        expect(container.querySelector("a")).toBe(link);
        expect(container.querySelector("img")).toBe(image);
        expect(document.activeElement).toBe(link);
      }

      await act(async () => root.render(createElement(Markdown, { source, imageSources: { "image.png": "/api/images/second" } })));
      expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/images/second");
      expect(document.activeElement).toBe(link);
      await act(async () => root.render(createElement(Markdown, { source })));
      expect(container.querySelector("img")?.getAttribute("src")).toBe("image.png");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
