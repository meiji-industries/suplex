import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const BridgeTokenSchema = z.string().uuid();

export const ROOT_BRIDGE_BINDING_ENV = "FORGE_ROOT_BINDING";
export const ROOT_BRIDGE_TOKEN_ENV = "FORGE_ROOT_TOKEN";
export const ADVISOR_BRIDGE_BINDING_ENV = "FORGE_ADVISOR_BINDING";
export const ADVISOR_BRIDGE_TOKEN_ENV = "FORGE_ADVISOR_TOKEN";
export const ADVISOR_BRIDGE_RESULT_ENV = "FORGE_ADVISOR_RESULT";

export const TASK_BRIDGE_ENVIRONMENT_KEYS = [
  ROOT_BRIDGE_BINDING_ENV,
  ROOT_BRIDGE_TOKEN_ENV,
  ADVISOR_BRIDGE_BINDING_ENV,
  ADVISOR_BRIDGE_TOKEN_ENV,
  ADVISOR_BRIDGE_RESULT_ENV,
] as const;

export function bridgeBindingPath(environment: NodeJS.ProcessEnv, name: string, label: string): string {
  const path = environment[name];
  if (!path) throw new Error(`${label} bridge requires ${name} in its environment`);
  return path;
}

export function authenticateBridgeToken(expected: string, environment: NodeJS.ProcessEnv, name: string, label: string): void {
  const expectedBytes = Buffer.from(BridgeTokenSchema.parse(expected));
  const actual = BridgeTokenSchema.safeParse(environment[name]);
  if (!actual.success) throw new Error(`${label} bridge authentication failed: ${name} is ${environment[name] === undefined ? "unset" : "not a valid token"}`);
  const actualBytes = Buffer.from(actual.data);
  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) throw new Error(`${label} bridge authentication failed: ${name} does not match the binding`);
}
