export type Row = Record<string, unknown>;

export const text = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" ? value : null;
};

export const integer = (row: Row, key: string): number => {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Invalid persisted ${key}`);
  return value;
};

export const parseJson = <T>(value: string | null, schema: { parse(input: unknown): T }): T | null => value === null ? null : schema.parse(JSON.parse(value));
