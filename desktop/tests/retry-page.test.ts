import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";

vi.mock("electron", () => ({}));

import { retryPage } from "../src/suplex-desktop";

const origin = "https://suplex.tail1234.ts.net";
const html = (address = origin): string => decodeURIComponent(retryPage(address).slice("data:text/html,".length));

function pageScript(clipboard?: { writeText: (text: string) => Promise<void> }, copyResult = true) {
  const source = html().match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!source) throw new Error("Retry page script is missing");
  let click: (() => Promise<void>) | undefined;
  const command = { textContent: "pnpm run suplex start" };
  const feedback = { textContent: "" };
  const copy = { textContent: "Copy", addEventListener: (_event: string, listener: () => Promise<void>) => { click = listener; } };
  const elements = new Map<string, unknown>([["command", command], ["copy", copy], ["copy-status", feedback], ["retry", { href: origin }]]);
  const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() };
  const range = { selectNodeContents: vi.fn() };
  const document = { getElementById: (id: string) => elements.get(id), createRange: () => range, execCommand: vi.fn(() => copyResult) };
  const timers: { callback: () => void; delay: number }[] = [];
  const location = { href: "data:text/html," };
  runInNewContext(source, {
    document, navigator: { clipboard }, window: { getSelection: () => selection }, location,
    setTimeout: (callback: () => void, delay: number) => { timers.push({ callback, delay }); },
  });
  return {
    command, copy, feedback, document, range, selection, timers, location,
    click: async () => {
      if (!click) throw new Error("Copy handler is missing");
      await click();
    },
  };
}

test("retry page has the connection diagram, host command, internal retry, and external install guide", () => {
  expect(html()).toContain('<html lang="en">');
  expect(html()).toContain('aria-label="This Suplex window cannot reach the Suplex host"');
  expect(html()).toContain(`<small>${origin}</small>`);
  expect(html()).toContain(`id="retry" href="${origin}"`);
  expect(html()).toContain('href="https://github.com/meiji-industries/suplex#set-up-an-installation"');
  expect(html()).toContain("pnpm run suplex start");
  expect(html()).toContain("Suplex retries every 5 seconds.");
  expect(html()).toContain('aria-label="Select a Suplex host"');
  expect(html()).toContain('window.suplexApp?.openHostPicker()');
  expect(html()).toContain('<span>Not available</span>');
  expect(html()).toContain("-webkit-app-region: no-drag");
  expect(html()).not.toMatch(/(?:href|src)="file:/);
});

test("addresses cannot inject HTML, attributes, or an inline script", () => {
  const address = 'https://suplex.example/"\'><img src=x onerror=alert(1)>&</script><script>alert(2)</script>';
  const escaped = "https://suplex.example/&quot;&#39;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;&lt;/script&gt;&lt;script&gt;alert(2)&lt;/script&gt;";
  expect(html(address)).toContain(`<small>${escaped}</small>`);
  expect(html(address)).toContain(`id="retry" href="${escaped}"`);
  expect(html(address).match(/<script>/g)).toHaveLength(1);
  expect(html(address)).not.toContain("<img");
  expect(html(address).match(/<script>([\s\S]*?)<\/script>/)?.[1]).not.toContain(address);
});

test("automatic retry uses the same origin after five seconds", () => {
  const page = pageScript();
  expect(page.timers).toHaveLength(1);
  expect(page.timers[0]?.delay).toBe(5000);
  expect(page.location.href).toBe("data:text/html,");
  page.timers[0]?.callback();
  expect(page.location.href).toBe(origin);
});

test("Copy reports success only after the clipboard write and resets after 1.5 seconds", async () => {
  let finishWrite: (() => void) | undefined;
  const write = new Promise<void>((resolve) => { finishWrite = resolve; });
  const writeText = vi.fn(() => write);
  const page = pageScript({ writeText });
  const pending = page.click();
  expect(writeText).toHaveBeenCalledWith("pnpm run suplex start");
  expect(page.copy.textContent).toBe("Copy");
  expect(page.feedback.textContent).toBe("");
  if (!finishWrite) throw new Error("Clipboard write is missing");
  finishWrite();
  await pending;
  expect(page.copy.textContent).toBe("Copied");
  expect(page.feedback.textContent).toBe("Command copied.");
  expect(page.document.execCommand).not.toHaveBeenCalled();
  const reset = page.timers.find((timer) => timer.delay === 1500);
  expect(reset).toBeDefined();
  reset?.callback();
  expect(page.copy.textContent).toBe("Copy");
});

test("Copy uses native selection when a data page has no Clipboard API", async () => {
  const page = pageScript();
  await page.click();
  expect(page.range.selectNodeContents).toHaveBeenCalledWith(page.command);
  expect(page.selection.addRange).toHaveBeenCalledWith(page.range);
  expect(page.document.execCommand).toHaveBeenCalledWith("copy");
  expect(page.copy.textContent).toBe("Copied");
  expect(page.feedback.textContent).toBe("Command copied.");
});

test.each(["clipboard", "selection"])("Copy gives a manual fallback when %s copying fails", async (mode) => {
  const page = pageScript(mode === "clipboard" ? { writeText: async () => { throw new Error("Permission denied"); } } : undefined, false);
  await page.click();
  expect(page.copy.textContent).toBe("Copy");
  expect(page.feedback.textContent).toBe("Copy failed. Select the command and copy it.");
  expect(page.timers).toHaveLength(1);
});
