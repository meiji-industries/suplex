import type { RepositoryConnection } from "../../../contracts/project-integration.js";
import type { DeliveryTarget } from "../../../contracts/tasks.js";

export function supportsDeliveryTarget(connection: RepositoryConnection | undefined, target: DeliveryTarget): boolean {
  return connection?.kind !== "bitbucket" || target !== "pull_request_ready" && target !== "merged";
}
