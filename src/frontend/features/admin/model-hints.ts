// Hand-written hints for the models that Suplex lists. Provider CLIs can list other models; those get the caller's fallback.
const MODEL_HINTS: Record<string, string> = {
  fable: "Most capable. Slow and expensive.",
  "claude-fable-5-1": "Most capable. Slow and expensive.",
  opus: "Strong reasoning. Good for plans and reviews.",
  "claude-opus-5-5": "Strong reasoning. Good for plans and reviews.",
  "claude-opus-5": "Strong reasoning. Older than Opus 5.5.",
  sonnet: "Fast and capable. Good for most code changes.",
  "claude-sonnet-5": "Fast and capable. Good for most code changes.",
  haiku: "Fastest and cheapest. Good for routine edits.",
  "claude-haiku-4-5-20251001": "Fastest and cheapest. Good for routine edits.",
  swe: "Made for code changes. Fast.",
  "swe-2": "Made for code changes. Fast.",
  gpt: "The latest GPT model.",
  "gpt-6-astra": "Most capable. Slow and expensive.",
  "gpt-6-sol": "Capable and fast. Good for most tasks.",
  "gpt-5.6-sol": "Strong reasoning. Good for plans and reviews.",
  "gpt-5.6-terra": "Balanced speed and cost. Good for most code changes.",
  "gpt-5.6-luna": "Fast and cheap. Good for routine edits.",
  "gpt-5.5": "Older model. Lower cost.",
};

/** OpenCode lists models as `vendor/model`, so the part after the last slash also matches. */
export function modelHint(id: string, fallback = ""): string {
  return MODEL_HINTS[id] ?? MODEL_HINTS[id.slice(id.lastIndexOf("/") + 1)] ?? fallback;
}
