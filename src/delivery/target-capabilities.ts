import type { RepositoryConnection } from "../projects/integration-configuration.js";
import type { DeliveryTarget } from "../tasks/contracts.js";

export function supportsDeliveryTarget(connection: RepositoryConnection | undefined, target: DeliveryTarget): boolean {
  return connection?.kind !== "bitbucket" || target !== "pull_request_ready" && target !== "merged";
}
