import { describe, expect, test } from "vitest";
import { invitationTarget, classifyNavigation, parseSuplexTarget, resolveSuplexTarget } from "../src/suplex-target";

describe("parseSuplexTarget", () => {
  test("normalizes and keeps the scheme, host, and port", () => {
    expect(parseSuplexTarget("https://suplex.tail1234.ts.net")).toEqual({ url: "https://suplex.tail1234.ts.net/", origin: "https://suplex.tail1234.ts.net" });
    expect(parseSuplexTarget("  https://suplex.tail1234.ts.net:4211  ")).toEqual({ url: "https://suplex.tail1234.ts.net:4211/", origin: "https://suplex.tail1234.ts.net:4211" });
    expect(parseSuplexTarget("https://suplex.tail1234.ts.net:443/").origin).toBe("https://suplex.tail1234.ts.net");
  });
  test("keeps a first page such as an invitation link, with the origin separate", () => {
    const target = parseSuplexTarget("https://suplex.tail1234.ts.net/auth?invite=abc");
    expect(target.url).toBe("https://suplex.tail1234.ts.net/auth?invite=abc");
    expect(target.origin).toBe("https://suplex.tail1234.ts.net");
  });
  test("rejects credentials, fragments, malformed values, and other schemes", () => {
    expect(() => parseSuplexTarget("https://user:pw@suplex.tail1234.ts.net")).toThrow(/credentials/);
    expect(() => parseSuplexTarget("https://user@suplex.tail1234.ts.net")).toThrow(/credentials/);
    expect(() => parseSuplexTarget("https://suplex.tail1234.ts.net/#top")).toThrow(/fragment/);
    expect(() => parseSuplexTarget("suplex.tail1234.ts.net")).toThrow(/absolute URL/);
    expect(() => parseSuplexTarget("")).toThrow(/absolute URL/);
    expect(() => parseSuplexTarget("file:///etc/passwd")).toThrow(/https/);
    expect(() => parseSuplexTarget("javascript:alert(1)")).toThrow(/https/);
    expect(() => parseSuplexTarget("ftp://suplex.tail1234.ts.net")).toThrow(/https/);
  });
  test("http is accepted only on the loopback host", () => {
    expect(parseSuplexTarget("http://localhost:4111").origin).toBe("http://localhost:4111");
    expect(parseSuplexTarget("http://127.0.0.1:4111").origin).toBe("http://127.0.0.1:4111");
    expect(parseSuplexTarget("http://[::1]:4111").origin).toBe("http://[::1]:4111");
    expect(() => parseSuplexTarget("http://suplex.tail1234.ts.net")).toThrow(/localhost/);
    expect(() => parseSuplexTarget("http://suplex.example.com")).toThrow(/localhost/);
  });
});

describe("resolveSuplexTarget", () => {
  const persisted = "https://persisted.tail1234.ts.net/";
  test("argument beats environment beats persisted", () => {
    const environment = { SUPLEX_DESKTOP_URL: "https://env.tail1234.ts.net" };
    expect(resolveSuplexTarget({ argv: ["--url", "https://arg.tail1234.ts.net"], environment, persisted })).toMatchObject({ source: "argument", target: { origin: "https://arg.tail1234.ts.net" } });
    expect(resolveSuplexTarget({ argv: ["--url=https://arg.tail1234.ts.net"], environment, persisted })).toMatchObject({ source: "argument" });
    expect(resolveSuplexTarget({ argv: ["/Applications/Suplex.app", "--url", "https://arg.tail1234.ts.net"], environment, persisted })).toMatchObject({ source: "argument" });
    expect(resolveSuplexTarget({ argv: ["Suplex", "--url", "--allow-file-access-from-files", ".", "https://arg.tail1234.ts.net"], environment, persisted }), "Chromium moves positionals after switches").toMatchObject({ source: "argument", target: { origin: "https://arg.tail1234.ts.net" } });
    expect(resolveSuplexTarget({ argv: ["Suplex", "--url=https://arg.tail1234.ts.net", "--allow-file-access-from-files", "."], environment, persisted })).toMatchObject({ source: "argument" });
    expect(resolveSuplexTarget({ argv: [], environment, persisted })).toMatchObject({ source: "environment", target: { origin: "https://env.tail1234.ts.net" } });
    expect(resolveSuplexTarget({ argv: [], environment: {}, persisted })).toMatchObject({ source: "persisted", target: { origin: "https://persisted.tail1234.ts.net" } });
    expect(resolveSuplexTarget({ argv: [], environment: {}, persisted: null })).toBeNull();
  });
  test("an explicit invalid value fails and never falls through", () => {
    expect(() => resolveSuplexTarget({ argv: ["--url", "http://suplex.example.com"], environment: {}, persisted })).toThrow(/^--url is not valid/);
    expect(() => resolveSuplexTarget({ argv: ["--url"], environment: {}, persisted })).toThrow(/^--url is not valid/);
    expect(() => resolveSuplexTarget({ argv: ["Suplex", "--url", "--some-flag", "."], environment: {}, persisted })).toThrow(/^--url is not valid/);
    expect(() => resolveSuplexTarget({ argv: [], environment: { SUPLEX_DESKTOP_URL: "" }, persisted })).toThrow(/^SUPLEX_DESKTOP_URL is not valid/);
    expect(() => resolveSuplexTarget({ argv: [], environment: { SUPLEX_DESKTOP_URL: "http://suplex.example.com" }, persisted })).toThrow(/^SUPLEX_DESKTOP_URL is not valid/);
  });
  test("an invalid persisted value is treated as absent", () => {
    expect(resolveSuplexTarget({ argv: [], environment: {}, persisted: "http://suplex.example.com/" })).toBeNull();
    expect(resolveSuplexTarget({ argv: [], environment: {}, persisted: "garbage" })).toBeNull();
  });
});

describe("classifyNavigation", () => {
  const origin = "https://suplex.tail1234.ts.net";
  test("compares the whole origin, including scheme and port", () => {
    expect(classifyNavigation("https://suplex.tail1234.ts.net/tasks/1?x=1", origin)).toEqual({ kind: "internal", url: "https://suplex.tail1234.ts.net/tasks/1?x=1" });
    expect(classifyNavigation("https://suplex.tail1234.ts.net:8443/", origin).kind).toBe("external");
    expect(classifyNavigation("http://suplex.tail1234.ts.net/", origin).kind).toBe("external");
    expect(classifyNavigation("https://suplex.tail1234.ts.net:443/", origin).kind).toBe("internal");
  });
  test("http and https elsewhere are external", () => {
    expect(classifyNavigation("https://github.com/meiji-industries/suplex", origin)).toEqual({ kind: "external", url: "https://github.com/meiji-industries/suplex" });
    expect(classifyNavigation("http://example.com", origin).kind).toBe("external");
  });
  test("everything else is blocked", () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "suplex-desktop://connect", "mailto:a@b.c", "not a url"]) {
      expect(classifyNavigation(url, origin).kind, url).toBe("blocked");
    }
  });
  test("with no configured origin nothing is internal", () => {
    expect(classifyNavigation("https://suplex.tail1234.ts.net/", null).kind).toBe("external");
  });
});

test("company invitation links accept only validated HTTPS targets", () => {
  expect(invitationTarget("suplex://join?url=" + encodeURIComponent("https://company.example/?company=one"))?.url).toBe("https://company.example/?company=one");
  for (const target of ["http://127.0.0.1:4111", "http://company.example", "javascript:alert(1)", "https://user:password@company.example", "https://company.example/#token"]) {
    expect(invitationTarget("suplex://join?url=" + encodeURIComponent(target))).toBeNull();
  }
  expect(invitationTarget("suplex://auth/done")).toBeNull();
  expect(invitationTarget("suplex://join?url=https://one.example&url=https://two.example")).toBeNull();
});
