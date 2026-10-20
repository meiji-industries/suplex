import { expect, test } from "vitest";

import { LocalEndpointBodySchema } from "../contracts/providers.js";
import { CHECK_STATUS_LABELS, localEndpointBody, validLocalEndpoint } from "../features/settings/local-endpoint-form.js";

test("the local endpoint body needs a URL and a model id, and the API key is optional", () => {
  expect(LocalEndpointBodySchema.parse({ baseUrl: " http://127.0.0.1:8080/v1 ", modelId: " mlx-community/Qwen3-30B-A3B-4bit " })).toEqual({ baseUrl: "http://127.0.0.1:8080/v1", modelId: "mlx-community/Qwen3-30B-A3B-4bit" });
  expect(LocalEndpointBodySchema.safeParse({ baseUrl: "127.0.0.1:8080", modelId: "qwen3" }).success).toBe(false);
  expect(LocalEndpointBodySchema.safeParse({ baseUrl: "http://127.0.0.1:8080/v1", modelId: "qwen 3" }).success).toBe(false);
  expect(LocalEndpointBodySchema.safeParse({ baseUrl: "http://127.0.0.1:8080/v1", modelId: "qwen3", extra: true }).success).toBe(false);
});

test("an empty API key is not sent", () => {
  expect(localEndpointBody({ baseUrl: "http://h:1/v1", apiKey: "  ", modelId: "m" })).toEqual({ baseUrl: "http://h:1/v1", modelId: "m" });
  expect(localEndpointBody({ baseUrl: "http://h:1/v1", apiKey: " key ", modelId: "m" })).toEqual({ baseUrl: "http://h:1/v1", modelId: "m", apiKey: "key" });
  expect(validLocalEndpoint({ baseUrl: "", apiKey: "", modelId: "m" })).toBe(false);
  expect(validLocalEndpoint({ baseUrl: "http://h:1/v1", apiKey: "", modelId: "m" })).toBe(true);
});

test("each check result has a plain label", () => {
  expect(CHECK_STATUS_LABELS).toEqual({ "model-listed": "Model listed", reachable: "Reachable", error: "Error" });
});
