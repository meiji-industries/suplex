// The frozen route list comes from Fastify's onRoute hook before the TypeScript
// engine was retired. HEAD is omitted because Axum answers it from each GET.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const expected: string[] = JSON.parse(readFileSync("tests/parity/routes.json", "utf8"));
const routes = expected.map(route => {
  const [method, path] = route.split(" ") as [string, string];
  return { method, path: path.replace(/ \(WebSocket\)$/, "") };
});

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
const rustFiles = readdirSync("apps/server/src/http", { recursive: true, encoding: "utf8" }).filter(file => file.endsWith(".rs")).map(file => join("apps/server/src/http", file));
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

const missing = routes.filter(({ method, path }) => !rust.some(route => route.method === method && route.pattern.test(path))).map(({ method, path }) => `${method} ${path}`).sort();
if (missing.length > 0) {
  console.error(`${missing.length} of ${routes.length} frozen route(s) have no Rust registration:\n${missing.join("\n")}`);
  process.exit(1);
}
console.log(`All ${routes.length} frozen method and path pairs have a Rust registration.`);
