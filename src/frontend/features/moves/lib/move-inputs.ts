import type { MoveInput } from "../../../contracts/generated/MoveInput.js";

const placeholder = /\{\{([^{}]*?)\}\}/g;

/** The browser twin of `rust/src/moves/prompt.rs::inputs`, for the live preview while you write a prompt. */
export function moveInputs(prompt: string): MoveInput[] {
  const inputs: MoveInput[] = [];
  for (const [, body = ""] of prompt.matchAll(placeholder)) {
    const colon = body.indexOf(":");
    const name = (colon < 0 ? body : body.slice(0, colon)).trim();
    const options = colon < 0 ? [] : body.slice(colon + 1).split("|").map(option => option.trim()).filter(Boolean);
    if (!/^[a-z][a-z0-9_]*$/.test(name) || (colon >= 0 && !options.length)) continue;
    const existing = inputs.find(input => input.name === name);
    if (!existing) inputs.push({ name, options });
    else if (!existing.options.length) existing.options = options;
  }
  return inputs;
}
