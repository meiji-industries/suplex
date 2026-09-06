export interface ModelPricing {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export type ModelPricingCatalog = ReadonlyMap<string, ModelPricing>;

export function modelPricingKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function estimateUsageCost(tokens: {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}, pricing: ModelPricing): number {
  const values = [tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write,
    pricing.input, pricing.output, pricing.cacheRead, pricing.cacheWrite];
  if (!values.every(value => Number.isFinite(value) && value >= 0)) return 0;
  const total = tokens.input * pricing.input
    + (tokens.output + tokens.reasoning) * pricing.output
    + tokens.cache.read * pricing.cacheRead
    + tokens.cache.write * pricing.cacheWrite;
  return Number.isFinite(total) && total > 0 ? total / 1_000_000 : 0;
}
