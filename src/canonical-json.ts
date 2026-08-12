export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new TypeError("Cannot canonicalize undefined");
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) if (!(index in value)) throw new TypeError("Cannot canonicalize a sparse array");
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Cannot canonicalize value");
  return encoded;
}
