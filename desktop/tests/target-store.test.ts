import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseSuplexTarget } from "../src/suplex-target";
import { clearTargets, forgetTarget, readTargets, rememberTarget } from "../src/target-store";

const file = (): string => join(mkdtempSync(join(tmpdir(), "suplex-desktop-store-")), "desktop.json");
const meiji = parseSuplexTarget("https://meiji.tail1234.ts.net:4111/auth?invite=abc");
const local = parseSuplexTarget("http://localhost:4211");

describe("target registry", () => {
  test("remembers only origins, newest first, with the last remembered one current", async () => {
    const path = file();
    await rememberTarget(path, meiji);
    const registry = await rememberTarget(path, local);
    expect(registry.current?.origin).toBe("http://localhost:4211");
    expect(registry.targets.map((target) => target.url)).toEqual(["http://localhost:4211/", "https://meiji.tail1234.ts.net:4111/"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ current: "http://localhost:4211/", targets: ["http://localhost:4211/", "https://meiji.tail1234.ts.net:4111/"] });
    expect(await readTargets(path)).toEqual(registry);
  });
  test("remembering a known origin moves it to the front without duplicating it", async () => {
    const path = file();
    await rememberTarget(path, meiji);
    await rememberTarget(path, local);
    const registry = await rememberTarget(path, parseSuplexTarget("https://meiji.tail1234.ts.net:4111/tasks/1"));
    expect(registry.targets.map((target) => target.origin)).toEqual(["https://meiji.tail1234.ts.net:4111", "http://localhost:4211"]);
    expect(registry.current?.origin).toBe("https://meiji.tail1234.ts.net:4111");
  });
  test("keeps at most eight origins", async () => {
    const path = file();
    for (let port = 1; port <= 10; port += 1) await rememberTarget(path, parseSuplexTarget(`https://suplex${port}.tail1234.ts.net`));
    const registry = await readTargets(path);
    expect(registry.targets).toHaveLength(8);
    expect(registry.targets[0]?.origin).toBe("https://suplex10.tail1234.ts.net");
  });
  test("forgetting the current origin leaves nothing current; forgetting the last one deletes the file", async () => {
    const path = file();
    await rememberTarget(path, meiji);
    await rememberTarget(path, local);
    const afterLocal = await forgetTarget(path, "http://localhost:4211");
    expect(afterLocal.current).toBeNull();
    expect(afterLocal.targets.map((target) => target.origin)).toEqual(["https://meiji.tail1234.ts.net:4111"]);
    const afterMeiji = await forgetTarget(path, "https://meiji.tail1234.ts.net:4111");
    expect(afterMeiji).toEqual({ current: null, targets: [] });
    expect(existsSync(path)).toBe(false);
  });
  test("migrates the old single-url file", async () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ url: "https://meiji.tail1234.ts.net:4111/" }));
    const registry = await readTargets(path);
    expect(registry.current?.origin).toBe("https://meiji.tail1234.ts.net:4111");
    expect(registry.targets).toHaveLength(1);
  });
  test("a missing file is empty", async () => {
    expect(await readTargets(file())).toEqual({ current: null, targets: [] });
  });
  test.each([
    ["corrupt JSON", "{not json"],
    ["an array", "[]"],
    ["a number", "42"],
  ])("%s is deleted and reported as empty", async (_name, content) => {
    const path = file();
    writeFileSync(path, content);
    expect(await readTargets(path)).toEqual({ current: null, targets: [] });
    expect(existsSync(path)).toBe(false);
  });
  test("invalid entries are dropped on read and a current that is not listed is ignored", async () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ current: "https://gone.tail1234.ts.net/", targets: ["http://suplex.example.com/", "https://u:p@meiji.tail1234.ts.net/", "https://meiji.tail1234.ts.net:4111/auth?invite=x", 42, "http://localhost:4211/"] }));
    const registry = await readTargets(path);
    expect(registry.targets.map((target) => target.origin)).toEqual(["http://localhost:4211"]);
    expect(registry.current).toBeNull();
  });
  test("clear removes the file and tolerates a missing one", async () => {
    const path = file();
    writeFileSync(path, "{}");
    await clearTargets(path);
    await clearTargets(path);
    expect(existsSync(path)).toBe(false);
  });
});
