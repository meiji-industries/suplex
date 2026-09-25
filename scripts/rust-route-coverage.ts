// Lists every `METHOD path` pair the TypeScript server registers that the Rust
// router does not. The TypeScript side is read from Fastify itself: the app is
// built with stub dependencies and every route is captured through `onRoute`,
// so API, page, public protocol (discovery, OAuth, MCP, agent pairing), asset,
// and WebSocket routes are all included. HEAD is skipped because Axum answers
// HEAD from each GET handler. The Rust side is read from the `router()`
// functions in `rust/src/http`, including the 501 stubs in `unported.rs`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAppServer, registerAppRoutes, type AppDependencies } from "../src/app.js";

// A stand-in for every service: route registration only stores it for handlers.
const stub: any = new Proxy(function () {}, {
  get: (_target, key) => key === "then" ? undefined
    : key === Symbol.iterator ? function* () {}
    : key === Symbol.toPrimitive ? () => "http://127.0.0.1:4111"
    : stub,
  apply: () => stub,
  construct: () => stub,
});
const absent = new Set(["logger", "https", "frontendDevelopment", "fullApp", "getHealth", "healthNow", "systemEvents"]);
const config = { reachableAddress: "http://127.0.0.1:4111", port: 4111 };
const dependencies = new Proxy({ config } as unknown as AppDependencies, {
  get: (target, key) => key in target ? target[key as keyof AppDependencies] : absent.has(String(key)) ? undefined : stub,
  has: () => true,
});

const app = createAppServer(dependencies);
const typescript = new Map<string, string>();
app.addHook("onRoute", route => {
  for (const method of [route.method].flat()) {
    if (method !== "HEAD") typescript.set(`${method} ${route.url.replace(/:[A-Za-z_]\w*/g, "{x}")}`, `${method} ${route.url}${"websocket" in route && route.websocket ? " (WebSocket)" : ""}`);
  }
});
registerAppRoutes(app, dependencies);
await app.ready();
await app.close();

// Returns the text inside the parentheses that open at `start`.
const enclosed = (text: string, start: number): string => {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "(" || text[index] === "[" || text[index] === "{") depth += 1;
    if (text[index] === ")" || text[index] === "]" || text[index] === "}") depth -= 1;
    if (depth === 0) return text.slice(start + 1, index);
  }
  throw new Error(`Unbalanced parentheses at ${start}`);
};
// Splits on commas outside brackets and string literals.
const topLevel = (text: string, separator: RegExp): string[] => {
  const parts: string[] = [];
  let depth = 0, quoted = false, last = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "\"" && text[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if ("([{".includes(character)) depth += 1;
    if (")]}".includes(character)) depth -= 1;
    if (depth === 0 && separator.test(character)) { parts.push(text.slice(last, index)); last = index + 1; }
  }
  return [...parts, text.slice(last)];
};

const rust: { method: string; pattern: RegExp }[] = [];
const register = (method: string, path: string) => rust.push({
  method,
  pattern: new RegExp(`^${path.replace(/\{\*[^}]+\}/g, "\0").replace(/\{[^}]+\}/g, "\u0001").replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\u0001/g, "[^/]+").replace(/\0/g, ".*")}$`),
});
const rustFiles = readdirSync("rust/src/http", { recursive: true, encoding: "utf8" }).filter(file => file.endsWith(".rs")).map(file => join("rust/src/http", file));
for (const file of rustFiles) {
  const source = readFileSync(file, "utf8").split("#[cfg(test)]")[0]!;
  for (const [, method, path] of source.matchAll(/\(\s*Method::([A-Z]+),\s*"([^"]+)"/g)) register(method!, path!);
  for (const match of source.matchAll(/\bfn router\(/g)) {
    const body = enclosed(source, source.indexOf("{", match.index));
    // Paths bound by `for prefix in [...]` or `[...].into_iter().fold(...)`.
    const bound = [...(body.match(/\[\s*("[^"]*"\s*,?\s*)+\]/)?.[0].matchAll(/"([^"]*)"/g) ?? [])].map(([, value]) => value!);
    for (const route of body.matchAll(/\.route\(/g)) {
      const [pathArgument, methods] = topLevel(enclosed(body, route.index + ".route".length), /,/).map(part => part.trim());
      const literal = pathArgument!.match(/"([^"]*)"/)?.[1];
      const paths = literal === undefined ? bound
        : pathArgument!.includes("format!") ? bound.map(prefix => literal.replace(/\{[a-z_]+\}/, prefix))
        : [literal];
      for (const [, name] of topLevel(methods!, /\./).map(link => link.trim().match(/^(?:axum::routing::)?(get|post|put|patch|delete)\(/) ?? [])) {
        if (name) for (const path of paths) register(name.toUpperCase(), path.replace(/\{\{/g, "{").replace(/\}\}/g, "}"));
      }
    }
  }
}

const missing = [...typescript].filter(([pair]) => {
  const [method, path] = pair.split(" ") as [string, string];
  return !rust.some(route => route.method === method && route.pattern.test(path));
}).map(([, source]) => source).sort();
if (missing.length > 0) {
  console.error(`${missing.length} of ${typescript.size} TypeScript route(s) have no Rust registration:\n${missing.join("\n")}`);
  process.exit(1);
}
console.log(`All ${typescript.size} TypeScript method and path pairs have a Rust registration.`);
