// Lists every TypeScript HTTP route pattern that has no Rust registration.
// Scope: `/api/` routes and the page routes in `pages.ts`. Public protocol
// routes (discovery, OAuth protocol, MCP, legacy UI assets) and routes built
// from template literals are outside the Rust port's known-route list.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const normalize = (path: string) => path.replace(/:[A-Za-z_]\w*/g, "{x}").replace(/\{[^}]+\}/g, "{x}");

const files = (directory: string, extension: string, recursive = false): string[] => readdirSync(directory, { recursive, encoding: "utf8" })
  .filter(file => file.endsWith(extension))
  .map(file => join(directory, file));

const typescript = new Map<string, string>();
for (const file of [...files("src/http/routes", ".ts"), ...files("src/http", ".ts")]) {
  for (const [, path] of readFileSync(file, "utf8").matchAll(/\b(?:typed|app)\.(?:get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
    if (path!.startsWith("/api/") || file.endsWith("pages.ts")) typescript.set(normalize(path!), `${file}: ${path}`);
  }
}

const rust = new Set<string>();
for (const file of files("rust/src/http", ".rs", true)) {
  for (const [, path] of readFileSync(file, "utf8").matchAll(/(?:\.route\(|\(\s*Method::[A-Z]+,)\s*"([^"]+)"/g)) rust.add(normalize(path!));
}

const missing = [...typescript].filter(([pattern]) => !rust.has(pattern)).map(([, source]) => source);
if (missing.length > 0) {
  console.error(`${missing.length} TypeScript route pattern(s) have no Rust registration:\n${missing.join("\n")}`);
  process.exit(1);
}
console.log(`All ${typescript.size} TypeScript route patterns have a Rust registration.`);
