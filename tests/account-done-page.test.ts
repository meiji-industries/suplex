import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";

const page = readFileSync(new URL("../apps/server/src/accounts/hosted/done.html", import.meta.url), "utf8");
const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";

/** Runs the page script against stand-ins for the browser globals it uses. */
function run(search: string): { close: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn>; link: { remove: ReturnType<typeof vi.fn> }; text: { textContent: string } } {
  const close = vi.fn();
  const replace = vi.fn();
  const link = { remove: vi.fn() };
  const text = { textContent: "Return to Suplex to continue. You can close this tab." };
  const document = { querySelector: (selector: string) => (selector === "a" ? link : selector === "p" ? text : null) };
  new Function("location", "document", "window", script)({ search, replace }, document, { close });
  return { close, replace, link, text };
}

test("a web login closes its tab as a backup and tells the user to close it if it stays open", () => {
  const web = run("?client=web");
  expect(web.close).toHaveBeenCalledTimes(1);
  expect(web.replace).not.toHaveBeenCalled();
  expect(web.link.remove).toHaveBeenCalled();
  expect(web.text.textContent).toBe("Suplex continues in the other tab. If this tab stays open, close it.");
  expect(page).toContain("<h1>You are logged in</h1>");
});

test("a desktop login opens the app and does not close the tab", () => {
  const desktop = run("");
  expect(desktop.replace).toHaveBeenCalledWith("suplex://auth/done");
  expect(desktop.close).not.toHaveBeenCalled();
  expect(desktop.link.remove).not.toHaveBeenCalled();
  expect(desktop.text.textContent).toBe("Return to Suplex to continue. You can close this tab.");
});
