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
const semanticInputs: Record<string, Record<string, unknown>> = {
  "common.IdSchema": {
    empty_string: "",
    max_length: "x".repeat(256),
    over_max_length: "x".repeat(257),
    astral_at_max: "😀".repeat(128),
    astral_over_max: "😀".repeat(129),
  },
  "common.CompanyIdParamsSchema": {
    empty_id: { companyId: "" },
    over_max_id: { companyId: "x".repeat(257) },
    astral_over_max_id: { companyId: "😀".repeat(129) },
  },
  "common.TaskArtifactParamsSchema": {
    both_ids_empty: { taskId: "", artifactId: "" },
    second_id_missing: { taskId: "task" },
  },
  "common.CompanyStatusParamsSchema": {
    invalid_status: { companyId: "company", status: "inactive" },
    valid_status: { companyId: "company", status: "paused", extra: true },
  },
  "common.TokenBodySchema": {
    explicit_empty: { token: "" },
    invalid_token: { token: null },
  },
  "common.RegistrationVerificationBodySchema": {
    null_response: { response: null },
    nested_response: { response: { id: "credential", extension: [1, null] }, token: "token" },
  },
  "common.AuthenticationVerificationBodySchema": {
    null_response: { response: null },
    nested_response: { response: [1, "x"] },
  },
  "common.EmptyBodySchema": {
    nested_unknown: { nested: { value: [1, null] } },
  },
  "common.ExpectedRevisionBodySchema": {
    null_revision: { expectedRevision: null },
    boolean_revision: { expectedRevision: true },
    numeric_string_revision: { expectedRevision: " 12 " },
    empty_string_revision: { expectedRevision: "" },
    hex_string_revision: { expectedRevision: "0x10" },
    binary_string_revision: { expectedRevision: "0b1010" },
    large_hex_string_revision: { expectedRevision: "0x10000000000000000" },
    invalid_inf_string_revision: { expectedRevision: "inf" },
    nested_array_revision: { expectedRevision: [[2]] },
    null_array_revision: { expectedRevision: [null] },
    empty_array_revision: { expectedRevision: [] },
    singleton_array_revision: { expectedRevision: [2] },
    multi_array_revision: { expectedRevision: [1, 2] },
    object_revision: { expectedRevision: {} },
    negative_revision: { expectedRevision: -1 },
    fractional_revision: { expectedRevision: 1.5 },
    unsafe_revision: { expectedRevision: 9_007_199_254_740_992 },
    infinity_string_revision: { expectedRevision: "Infinity" },
    negative_infinity_string_revision: { expectedRevision: "-Infinity" },
    byte_order_mark_revision: { expectedRevision: "\ufeff3\ufeff" },
    optional_limits: { expectedRevision: 1, commandId: "x", idempotencyKey: "y", automatic: true, extra: true },
    empty_command_id: { expectedRevision: 1, commandId: "" },
    array_command_id: { expectedRevision: 1, commandId: [] },
    long_idempotency_key: { expectedRevision: 1, idempotencyKey: "x".repeat(257) },
  },
  "common.ExpectedRevisionNoteBodySchema": {
    optional_note: { expectedRevision: "2", note: "" },
    invalid_note: { expectedRevision: 1, note: null },
  },
  "common.RequiredRevisionNoteBodySchema": {
    trimmed_note: { expectedRevision: 1, note: "  Ready  " },
    empty_trimmed_note: { expectedRevision: 1, note: " \t " },
    wrong_note_type: { expectedRevision: 1, note: [] },
  },
  "common.HttpPlanDecisionBodySchema": {
    valid_key: { note: "  Yes  ", idempotencyKey: "A_b:c-123" },
    short_key: { note: "Yes", idempotencyKey: "short" },
    long_key: { note: "Yes", idempotencyKey: "a".repeat(129) },
    invalid_first_character: { note: "Yes", idempotencyKey: "_abcdefg" },
    invalid_key_character: { note: "Yes", idempotencyKey: "abc defgh" },
    short_invalid_key: { note: "Yes", idempotencyKey: "bad key" },
    empty_array_key: { note: "Yes", idempotencyKey: [] },
    empty_array_note: { note: [], idempotencyKey: "abcdefgh" },
    empty_note: { note: "  ", idempotencyKey: "abcdefghi" },
  },
  "common.HttpSupplementalReviewBodySchema": {
    null_revision: { expectedRevision: null, idempotencyKey: "abcdefghi" },
    negative_revision: { expectedRevision: -1, idempotencyKey: "abcdefghi" },
    fractional_revision: { expectedRevision: 1.5, idempotencyKey: "abcdefghi" },
  },
  "common.HttpPlanBlockerResponseBodySchema": {
    wrong_revision_type: { expectedWorkflowRevision: "1", answer: "Yes", idempotencyKey: "abcdefghi" },
    negative_revision: { expectedWorkflowRevision: -1, answer: "Yes", idempotencyKey: "abcdefghi" },
    trimmed_answer: { expectedWorkflowRevision: 1, answer: "  Yes  ", idempotencyKey: "abcdefghi" },
    unsafe_revision: { expectedWorkflowRevision: 9_007_199_254_740_992, answer: "Yes", idempotencyKey: "abcdefghi" },
  },
  "common.ResolveDecisionBlockerBodySchema": {
    empty_answer: { expectedRevision: 1, answer: "" },
    whitespace_answer: { expectedRevision: 1, answer: "  " },
    numeric_answer: { expectedRevision: 1, answer: 1 },
  },
  "providers.ProviderConnectionSchema": {
    optional_account: { status: "connected", summary: "Ready", account: "user@example.test", extra: true },
    invalid_status: { status: "ready", summary: "Ready" },
    null_account: { status: "unknown", summary: "Unknown", account: null },
  },
  "providers.NativeProviderSummarySchema": {
    negative_model_count: { id: "opencode", label: "OpenCode", modelCount: -1, models: [], status: "configured" },
    fractional_model_count: { id: "codex", label: "Codex", modelCount: 1.5, models: [], status: "configured" },
    unsafe_model_count: { id: "codex", label: "Codex", modelCount: 9_007_199_254_740_992, models: [], status: "configured" },
    nested_model_error: { id: "codex", label: "Codex", modelCount: 1, models: [{ id: "model", label: null }], status: "configured" },
    nested_model_strip: { id: "codex", label: "Codex", modelCount: 1, models: [{ id: "model", label: "Model", extra: true }], status: "configured", extra: true },
    models_wrong_type: { id: "codex", label: "Codex", modelCount: 0, models: {}, status: "configured" },
  },
  "providers.ProviderSummarySchema": {
    nested_connection_error: { id: "devin", label: "Devin", modelCount: 0, models: [], status: "missing", connection: { status: "ready", summary: 1 } },
  },
  "providers.ProviderListResponseSchema": {
    nested_provider_error: { directory: "/tmp", observedAt: "now", providers: [{ id: "bad", label: "Bad", modelCount: -1, models: [], status: "missing", connection: { status: "unknown", summary: "?" } }] },
  },
  "providers.ProviderInstanceSchema": {
    invalid_provider: { id: "1", provider: "other", label: "Other", homeDirectory: "/tmp", createdAt: "now", updatedAt: "now" },
    unknown_on_valid_nested: { id: "1", provider: "codex", label: "Codex", homeDirectory: "/tmp", createdAt: "now", updatedAt: "now", extra: true },
  },
  "providers.ProviderInstanceReadinessSchema": {
    invalid_status: { status: "ready", summary: "Ready" },
  },
  "providers.ProviderInstanceListResponseSchema": {
    nested_instance_error: { instances: [{ id: "1", provider: "codex", label: "Codex", homeDirectory: "/tmp", createdAt: "now", updatedAt: "now", readiness: { status: "wrong", summary: "" }, connection: { status: "unknown", summary: "?" } }] },
  },
  "providers.ProviderInstanceCreateBodySchema": {
    trim_label: { provider: "codex", label: "  Codex  " },
    empty_trimmed_label: { provider: "codex", label: " \t " },
    max_label: { provider: "codex", label: "x".repeat(128) },
    over_max_label: { provider: "codex", label: "x".repeat(129) },
    astral_over_max_label: { provider: "codex", label: "😀".repeat(65) },
    byte_order_mark_trim: { provider: "codex", label: "\ufeffCodex\ufeff" },
    next_line_not_trimmed: { provider: "codex", label: "\u0085Codex\u0085" },
    wrong_provider: { provider: "other", label: "Codex" },
    label_empty_array: { provider: "codex", label: [] },
    label_large_array: { provider: "codex", label: Array(129).fill("x") },
  },
  "providers.ProviderLoginResponseSchema": {
    invalid_pane: { paneId: 1 },
  },
};

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
    for (const [caseName, input] of Object.entries(semanticInputs[contract] ?? {})) {
      const parsed = schema.safeParse(input);
      const fixture: Fixture = { contract, case: caseName, input, expected: parsed.success ? { accepted: true, value: parsed.data } : { accepted: false, error: parsed.error.issues } };
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
