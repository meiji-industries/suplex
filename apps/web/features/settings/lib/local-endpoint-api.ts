import type { LocalEndpointResponse } from "../../../contracts/generated/LocalEndpointResponse.js";
import type { LocalEndpointTestResponse } from "../../../contracts/generated/LocalEndpointTestResponse.js";
import { LocalEndpointBodySchema, type LocalEndpointBody } from "../../../contracts/providers.js";
import { readJsonUnchecked } from "../../../lib/api.js";

/** Saves the endpoint. The server keeps the API key and never returns it. */
export function createLocalEndpoint(body: LocalEndpointBody): Promise<LocalEndpointResponse> {
  return readJsonUnchecked<LocalEndpointResponse>("/api/admin/local-endpoints", { method: "POST", body: JSON.stringify(LocalEndpointBodySchema.parse(body)) });
}

export async function deleteLocalEndpoint(id: string): Promise<void> {
  await readJsonUnchecked<unknown>(`/api/admin/local-endpoints/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Asks the endpoint for its models. Suplex saves nothing. */
export function testLocalEndpoint(body: Omit<LocalEndpointBody, "label">): Promise<LocalEndpointTestResponse> {
  return readJsonUnchecked<LocalEndpointTestResponse>("/api/admin/local-endpoints/test", { method: "POST", body: JSON.stringify(LocalEndpointBodySchema.omit({ label: true }).parse(body)) });
}
