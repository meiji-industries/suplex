import { describe, expect, test } from "vitest";
import { classifyNavigation, parseForgeTarget, resolveForgeTarget } from "../src/forge-target";

describe("parseForgeTarget", () => {
  test("normalizes and keeps the scheme, host, and port", () => {
    expect(parseForgeTarget("https://forge.tail1234.ts.net")).toEqual({ url: "https://forge.tail1234.ts.net/", origin: "https://forge.tail1234.ts.net" });
    expect(parseForgeTarget("  https://forge.tail1234.ts.net:4211  ")).toEqual({ url: "https://forge.tail1234.ts.net:4211/", origin: "https://forge.tail1234.ts.net:4211" });
    expect(parseForgeTarget("https://forge.tail1234.ts.net:443/").origin).toBe("https://forge.tail1234.ts.net");
  });
  test("keeps a first page such as an invitation link, with the origin separate", () => {
    const target = parseForgeTarget("https://forge.tail1234.ts.net/auth?invite=abc");
    expect(target.url).toBe("https://forge.tail1234.ts.net/auth?invite=abc");
    expect(target.origin).toBe("https://forge.tail1234.ts.net");
  });
  test("rejects credentials, fragments, malformed values, and other schemes", () => {
    expect(() => parseForgeTarget("https://user:pw@forge.tail1234.ts.net")).toThrow(/credentials/);
    expect(() => parseForgeTarget("https://user@forge.tail1234.ts.net")).toThrow(/credentials/);
    expect(() => parseForgeTarget("https://forge.tail1234.ts.net/#top")).toThrow(/fragment/);
    expect(() => parseForgeTarget("forge.tail1234.ts.net")).toThrow(/absolute URL/);
    expect(() => parseForgeTarget("")).toThrow(/absolute URL/);
    expect(() => parseForgeTarget("file:///etc/passwd")).toThrow(/https/);
    expect(() => parseForgeTarget("javascript:alert(1)")).toThrow(/https/);
    expect(() => parseForgeTarget("ftp://forge.tail1234.ts.net")).toThrow(/https/);
  });
  test("http is accepted only on the loopback host", () => {
    expect(parseForgeTarget("http://localhost:4111").origin).toBe("http://localhost:4111");
    expect(parseForgeTarget("http://127.0.0.1:4111").origin).toBe("http://127.0.0.1:4111");
    expect(parseForgeTarget("http://[::1]:4111").origin).toBe("http://[::1]:4111");
    expect(() => parseForgeTarget("http://forge.tail1234.ts.net")).toThrow(/localhost/);
    expect(() => parseForgeTarget("http://forge.example.com")).toThrow(/localhost/);
  });
});

describe("resolveForgeTarget", () => {
  const persisted = "https://persisted.tail1234.ts.net/";
  test("argument beats environment beats persisted", () => {
    const environment = { FORGE_DESKTOP_URL: "https://env.tail1234.ts.net" };
    expect(resolveForgeTarget({ argv: ["--url", "https://arg.tail1234.ts.net"], environment, persisted })).toMatchObject({ source: "argument", target: { origin: "https://arg.tail1234.ts.net" } });
    expect(resolveForgeTarget({ argv: ["--url=https://arg.tail1234.ts.net"], environment, persisted })).toMatchObject({ source: "argument" });
    expect(resolveForgeTarget({ argv: ["/Applications/Forge.app", "--url", "https://arg.tail1234.ts.net"], environment, persisted })).toMatchObject({ source: "argument" });
    expect(resolveForgeTarget({ argv: ["Forge", "--url", "--allow-file-access-from-files", ".", "https://arg.tail1234.ts.net"], environment, persisted }), "Chromium moves positionals after switches").toMatchObject({ source: "argument", target: { origin: "https://arg.tail1234.ts.net" } });
    expect(resolveForgeTarget({ argv: ["Forge", "--url=https://arg.tail1234.ts.net", "--allow-file-access-from-files", "."], environment, persisted })).toMatchObject({ source: "argument" });
    expect(resolveForgeTarget({ argv: [], environment, persisted })).toMatchObject({ source: "environment", target: { origin: "https://env.tail1234.ts.net" } });
    expect(resolveForgeTarget({ argv: [], environment: {}, persisted })).toMatchObject({ source: "persisted", target: { origin: "https://persisted.tail1234.ts.net" } });
    expect(resolveForgeTarget({ argv: [], environment: {}, persisted: null })).toBeNull();
  });
  test("an explicit invalid value fails and never falls through", () => {
    expect(() => resolveForgeTarget({ argv: ["--url", "http://forge.example.com"], environment: {}, persisted })).toThrow(/^--url is not valid/);
    expect(() => resolveForgeTarget({ argv: ["--url"], environment: {}, persisted })).toThrow(/^--url is not valid/);
    expect(() => resolveForgeTarget({ argv: ["Forge", "--url", "--some-flag", "."], environment: {}, persisted })).toThrow(/^--url is not valid/);
    expect(() => resolveForgeTarget({ argv: [], environment: { FORGE_DESKTOP_URL: "" }, persisted })).toThrow(/^FORGE_DESKTOP_URL is not valid/);
    expect(() => resolveForgeTarget({ argv: [], environment: { FORGE_DESKTOP_URL: "http://forge.example.com" }, persisted })).toThrow(/^FORGE_DESKTOP_URL is not valid/);
  });
  test("an invalid persisted value is treated as absent", () => {
    expect(resolveForgeTarget({ argv: [], environment: {}, persisted: "http://forge.example.com/" })).toBeNull();
    expect(resolveForgeTarget({ argv: [], environment: {}, persisted: "garbage" })).toBeNull();
  });
});

describe("classifyNavigation", () => {
  const origin = "https://forge.tail1234.ts.net";
  test("compares the whole origin, including scheme and port", () => {
    expect(classifyNavigation("https://forge.tail1234.ts.net/tasks/1?x=1", origin)).toEqual({ kind: "internal", url: "https://forge.tail1234.ts.net/tasks/1?x=1" });
    expect(classifyNavigation("https://forge.tail1234.ts.net:8443/", origin).kind).toBe("external");
    expect(classifyNavigation("http://forge.tail1234.ts.net/", origin).kind).toBe("external");
    expect(classifyNavigation("https://forge.tail1234.ts.net:443/", origin).kind).toBe("internal");
  });
  test("http and https elsewhere are external", () => {
    expect(classifyNavigation("https://github.com/meiji-industries/forge", origin)).toEqual({ kind: "external", url: "https://github.com/meiji-industries/forge" });
    expect(classifyNavigation("http://example.com", origin).kind).toBe("external");
  });
  test("everything else is blocked", () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "forge-desktop://connect", "mailto:a@b.c", "not a url"]) {
      expect(classifyNavigation(url, origin).kind, url).toBe("blocked");
    }
  });
  test("with no configured origin nothing is internal", () => {
    expect(classifyNavigation("https://forge.tail1234.ts.net/", null).kind).toBe("external");
  });
});
