import { expect, test } from "vitest";
import { ModelsDevCatalogReader, parseModelsDevCatalog } from "../src/models-dev-catalog.js";

test("models.dev reader extracts validated model prices and caches successful reads", async () => {
  let calls = 0;
  const reader = new ModelsDevCatalogReader({
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        secret: "drop me",
        openai: {
          id: "openai",
          api: "drop me",
          models: {
            model: { id: "model", name: "Model", cost: { input: 2, output: 5, cache_read: 0.5, cache_write: 1 }, apiKey: "drop me" },
            full: { id: "openai/full", cost: { input: 1, output: 2 } },
            zero: { id: "zero", cost: { input: 0, output: 0 } },
            malformed: { id: "malformed", cost: { input: "bad", output: 2 } },
            missing: { id: "missing" },
          },
        },
      }));
    },
  });
  const first = await reader.read();
  const second = await reader.read();
  expect(calls).toBe(1);
  expect(first).toBe(second);
  expect(first?.get("openai/model")).toEqual({ input: 2, output: 5, cacheRead: 0.5, cacheWrite: 1 });
  expect(first?.get("openai/full")).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  expect(first?.get("openai/zero")).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  expect(first?.get("openai/malformed")).toBeUndefined();
  expect(first?.get("openai/missing")).toBeUndefined();
});

test("models.dev reader treats malformed or unreachable catalogs as unavailable", async () => {
  expect(parseModelsDevCatalog({ openai: { id: "openai", models: { model: { id: "model", cost: { input: -1, output: 2 } } } } }).size).toBe(0);
  const malformed = new ModelsDevCatalogReader({ fetch: async () => new Response("[]") });
  expect(await malformed.read()).toBeUndefined();
  const reader = new ModelsDevCatalogReader({ fetch: async () => { throw new Error("offline"); } });
  expect(await reader.read()).toBeUndefined();
});

test("models.dev reader caches a valid empty catalog", async () => {
  let calls = 0;
  const reader = new ModelsDevCatalogReader({ fetch: async () => { calls += 1; return new Response("{}"); } });
  const first = await reader.read();
  const second = await reader.read();
  expect(calls).toBe(1);
  expect(first).toBe(second);
  expect(first?.size).toBe(0);
});
