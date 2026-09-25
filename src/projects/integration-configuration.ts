export { RepositoryConnectionSchema, TrackerConnectionSchema, ProjectIntegrationSchema } from "./integration-contracts.js";
export type { RepositoryConnection, TrackerConnection, ProjectIntegration } from "./integration-contracts.js";

export class MissingIntegrationCredential extends Error {}

export function environmentCredential(name: string, environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment[name];
  if (!value) throw new MissingIntegrationCredential(`The credential reference ${name} is not available`);
  return value;
}
