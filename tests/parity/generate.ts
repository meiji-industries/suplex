import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";

const root = fileURLToPath(new URL(".", import.meta.url));
const modules = ["agent-api", "auth", "avatars", "common", "github-triggers", "oauth", "projects", "providers", "system-events", "task-templates", "tasks", "update", "workflows"] as const;
const inputs = {
  missing: undefined,
  null: null,
  empty_object: {},
  unknown_field: { unexpected: true },
  empty_array: [],
} as const;

type Fixture = { contract: string; case: string; input?: unknown; expected: { accepted: true; value: unknown } | { accepted: false; error: z.core.$ZodIssue[] } };
type Definition = { type: string; innerType?: z.ZodType; element?: z.ZodType; shape?: Record<string, z.ZodType>; options?: z.ZodType[]; entries?: Record<string, string>; values?: unknown[]; keyType?: z.ZodType; valueType?: z.ZodType; items?: z.ZodType[]; in?: z.ZodType; checks?: Array<{ _zod: { def: { check?: string; minimum?: number; value?: number; inclusive?: boolean } } }> };
const definition = (schema: z.ZodType): Definition => schema._zod.def as Definition;
const accepted = (schema: z.ZodType, input: unknown): boolean => schema.safeParse(input).success;

function representative(schema: z.ZodType, includeOptional = false): unknown {
  const def = definition(schema);
  switch (def.type) {
    case "default": return undefined;
    case "optional": return includeOptional ? representative(def.innerType!, true) : undefined;
    case "nullable": return null;
    case "readonly": return representative(def.innerType!, includeOptional);
    case "pipe": return representative(def.in!, includeOptional);
    case "literal": return def.values![0];
    case "enum": return Object.values(def.entries!)[0];
    case "boolean": return true;
    case "number": {
      const minimum = def.checks?.find(check => check._zod.def.check === "greater_than")?._zod.def;
      const first = minimum?.value === undefined ? 1 : Math.max(1, Math.ceil(minimum.value + (minimum.inclusive ? 0 : 1)));
      return [first, 0, 2, 50].find(value => accepted(schema, value)) ?? first;
    }
    case "string": {
      const min = def.checks?.find(check => check._zod.def.check === "min_length")?._zod.def.minimum ?? 1;
      const options = ["x".repeat(Math.max(1, min)), "sample-001", "00000000-0000-4000-8000-000000000001", "2026-09-24T00:00:00.000Z", "https://github.com/example/repo/issues/1", "https://example.atlassian.net/", "example/repo", "ABC-123", "a".repeat(32), "a".repeat(40), "a".repeat(64), "A", "aGVsbG8="];
      return options.find(value => accepted(schema, value)) ?? options[0];
    }
    case "array": {
      const item = representative(def.element!, includeOptional);
      return [[], [item], [item, item]].find(value => accepted(schema, value)) ?? [];
    }
    case "tuple": return def.items!.map(item => representative(item, includeOptional));
    case "record": return {};
    case "object": {
      const value = Object.fromEntries(Object.entries(def.shape!).flatMap(([key, field]) => {
        const generated = representative(field, includeOptional);
        return generated === undefined ? [] : [[key, generated]];
      }));
      if (accepted(schema, value)) return value;
      if (!includeOptional) return representative(schema, true);
      return value;
    }
    case "union": {
      for (const option of def.options ?? []) {
        const generated = representative(option, includeOptional);
        if (accepted(schema, generated)) return generated;
      }
      return representative(def.options![0]!, includeOptional);
    }
    case "unknown": case "any": return null;
    default: throw new Error(`Unsupported Zod fixture shape: ${def.type}`);
  }
}

let schemas = 0;
let fixtures = 0;
const check = process.argv.includes("--check");
for (const moduleName of modules) {
  const exports = await import(`../../src/http/contracts/${moduleName}.js`) as Record<string, unknown>;
  for (const [name, candidate] of Object.entries(exports).sort(([left], [right]) => left.localeCompare(right))) {
    if (!name.endsWith("Schema") || !candidate || typeof candidate !== "object" || !("safeParse" in candidate) || typeof candidate.safeParse !== "function") continue;
    const schema = candidate as z.ZodType;
    const contract = `${moduleName}.${name}`;
    const directory = join(root, contract);
    if (!check) await mkdir(directory, { recursive: true });
    schemas++;
    for (const [caseName, input] of Object.entries(inputs)) {
      const parsed = schema.safeParse(input);
      const fixture: Fixture = { contract, case: caseName, ...(caseName === "missing" ? {} : { input }), expected: parsed.success ? { accepted: true, value: parsed.data } : { accepted: false, error: parsed.error.issues } };
      const path = join(directory, `${caseName}.json`);
      const content = `${JSON.stringify(fixture, null, 2)}\n`;
      if (check) {
        if (await readFile(path, "utf8") !== content) throw new Error(`Stale parity fixture: ${path}`);
      } else await writeFile(path, content);
      fixtures++;
    }
    const input = representative(schema);
    if (!accepted(schema, input)) throw new Error(`No accepted representative for ${contract}: ${JSON.stringify(schema.safeParse(input))}`);
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new Error(`Unexpected rejected representative for ${contract}`);
    const fixture: Fixture = { contract, case: "representative", input, expected: { accepted: true, value: parsed.data } };
    const path = join(directory, "representative.json");
    const content = `${JSON.stringify(fixture, null, 2)}\n`;
    if (check) {
      if (await readFile(path, "utf8") !== content) throw new Error(`Stale parity fixture: ${path}`);
    } else await writeFile(path, content);
    fixtures++;
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const additions: Record<string, unknown> = {
        unknown_on_valid: { ...input, __parityUnknown: true },
      };
      const first = Object.keys(input)[0];
      if (first) {
        const without: Record<string, unknown> = { ...input };
        delete without[first];
        additions.first_field_missing = without;
        additions.first_field_null = { ...input, [first]: null };
      }
      for (const [caseName, candidate] of Object.entries(additions)) {
        const result = schema.safeParse(candidate);
        const fixture: Fixture = { contract, case: caseName, input: candidate, expected: result.success ? { accepted: true, value: result.data } : { accepted: false, error: result.error.issues } };
        const path = join(directory, `${caseName}.json`);
        const content = `${JSON.stringify(fixture, null, 2)}\n`;
        if (check) {
          if (await readFile(path, "utf8") !== content) throw new Error(`Stale parity fixture: ${path}`);
        } else await writeFile(path, content);
        fixtures++;
      }
    }
  }
}
console.log(`${check ? "Checked" : "Generated"} ${fixtures} Zod fixtures for ${schemas} exported HTTP schemas.`);
