import { z } from "zod";
import { modelPricingKey, type ModelPricing, type ModelPricingCatalog } from "./model-pricing.js";

const rate = z.number().finite().nonnegative();
const catalogRoot = z.record(z.string(), z.unknown());
const provider = z.object({ id: z.string().min(1), models: z.record(z.string(), z.unknown()) }).passthrough();
const model = z.object({ id: z.string().min(1), cost: z.unknown() }).passthrough();
const cost = z.object({
  input: rate,
  output: rate,
  cache_read: rate.optional().default(0),
  cache_write: rate.optional().default(0),
}).passthrough();

export const MODELS_DEV_CATALOG_URL = "https://models.dev/api.json";
export type ModelsDevFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface ModelsDevCatalogReaderOptions {
  fetch?: ModelsDevFetch;
  url?: string;
  timeoutMs?: number;
}
export interface ModelPricingReader {
  read(): Promise<ModelPricingCatalog | undefined>;
}

export function parseModelsDevCatalog(value: unknown): ModelPricingCatalog {
  const root = catalogRoot.safeParse(value);
  if (!root.success) return new Map();
  const result = new Map<string, ModelPricing>();
  for (const rawProvider of Object.values(root.data)) {
    const parsedProvider = provider.safeParse(rawProvider);
    if (!parsedProvider.success) continue;
    for (const rawModel of Object.values(parsedProvider.data.models)) {
      const parsedModel = model.safeParse(rawModel);
      if (!parsedModel.success) continue;
      const parsedCost = cost.safeParse(parsedModel.data.cost);
      if (!parsedCost.success) continue;
      const modelId = parsedModel.data.id.startsWith(`${parsedProvider.data.id}/`)
        ? parsedModel.data.id.slice(parsedProvider.data.id.length + 1)
        : parsedModel.data.id;
      if (!modelId) continue;
      result.set(modelPricingKey(parsedProvider.data.id, modelId), {
        input: parsedCost.data.input,
        output: parsedCost.data.output,
        cacheRead: parsedCost.data.cache_read,
        cacheWrite: parsedCost.data.cache_write,
      });
    }
  }
  return result;
}

export class ModelsDevCatalogReader implements ModelPricingReader {
  private cached: ModelPricingCatalog | undefined;
  private pending: Promise<ModelPricingCatalog | undefined> | undefined;
  private readonly fetcher: ModelsDevFetch;
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(options: ModelsDevCatalogReaderOptions = {}) {
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.url = options.url ?? MODELS_DEV_CATALOG_URL;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 5_000);
  }

  read(): Promise<ModelPricingCatalog | undefined> {
    if (this.cached) return Promise.resolve(this.cached);
    if (this.pending) return this.pending;
    const pending = this.load().catch(() => undefined).then(catalog => {
      if (catalog) this.cached = catalog;
      return catalog;
    }).finally(() => { this.pending = undefined; });
    this.pending = pending;
    return pending;
  }

  private async load(): Promise<ModelPricingCatalog | undefined> {
    const response = await this.fetcher(this.url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) return undefined;
    const value = await response.json();
    if (!catalogRoot.safeParse(value).success) return undefined;
    return parseModelsDevCatalog(value);
  }
}
