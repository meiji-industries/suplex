import { useState } from "react";

import type { LocalEndpointTestResponse } from "../../contracts/generated/LocalEndpointTestResponse.js";
import type { LocalEndpointTestStatus } from "../../contracts/generated/LocalEndpointTestStatus.js";
import { LocalEndpointBodySchema, type LocalEndpointBody } from "../../contracts/providers.js";
import { createLocalEndpoint, testLocalEndpoint } from "./lib/local-endpoint-api.js";

export type LocalEndpointFields = { baseUrl: string; apiKey: string; modelId: string };

const EMPTY: LocalEndpointFields = { baseUrl: "", apiKey: "", modelId: "" };

export const LOCAL_ENDPOINT_TITLE = "Local or custom endpoint";

/** The result of Check in plain words. */
export const CHECK_STATUS_LABELS: Record<LocalEndpointTestStatus, string> = {
  "model-listed": "Model listed",
  reachable: "Reachable",
  error: "Error",
};

/** The request body for the form fields. An empty API key is absent. */
export function localEndpointBody(fields: LocalEndpointFields): LocalEndpointBody {
  return { baseUrl: fields.baseUrl.trim(), modelId: fields.modelId.trim(), ...(fields.apiKey.trim() ? { apiKey: fields.apiKey.trim() } : {}) };
}

export function validLocalEndpoint(fields: LocalEndpointFields): boolean {
  return LocalEndpointBodySchema.safeParse(localEndpointBody(fields)).success;
}

/** The fields, Check, and Add of the local endpoint form in Your stack and in Settings. */
export function useLocalEndpointForm(onAdded: () => Promise<void> | void) {
  const [fields, setFields] = useState<LocalEndpointFields>(EMPTY);
  const [check, setCheck] = useState<LocalEndpointTestResponse | null>(null);
  const [busy, setBusy] = useState<"check" | "add" | null>(null);
  const [error, setError] = useState("");
  const valid = validLocalEndpoint(fields);
  const change = (patch: Partial<LocalEndpointFields>): void => {
    setFields(current => ({ ...current, ...patch }));
    setCheck(null);
    setError("");
  };
  const reset = (): void => { setFields(EMPTY); setCheck(null); setError(""); };
  const runCheck = async (): Promise<void> => {
    if (!valid || busy) return;
    setBusy("check");
    setError("");
    try {
      setCheck(await testLocalEndpoint(localEndpointBody(fields)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Suplex could not check the endpoint.");
    } finally {
      setBusy(null);
    }
  };
  const add = async (): Promise<boolean> => {
    if (!valid || busy) return false;
    setBusy("add");
    setError("");
    try {
      await createLocalEndpoint(localEndpointBody(fields));
      reset();
      await onAdded();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Suplex could not add the endpoint.");
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { fields, change, valid, check, busy, error, runCheck, add, reset };
}
