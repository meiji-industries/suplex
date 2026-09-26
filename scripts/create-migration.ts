import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const rawName = process.argv.slice(2).join(" ").trim();
const name = rawName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
if (!name) throw new Error("Usage: pnpm migration:new <migration name>");

const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
const folder = resolve(process.cwd(), "migrations");
const path = resolve(folder, `${timestamp}_${name}.sql`);
mkdirSync(folder, { recursive: true });
const descriptor = openSync(path, "wx");
try {
  writeFileSync(descriptor, "-- Write migration SQL here.\n");
} finally {
  closeSync(descriptor);
}
console.log(path);
