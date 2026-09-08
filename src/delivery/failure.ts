import type { DeliveryFailureCode } from "../coordination/workflows.js";

export class DeliveryOperationFailure extends Error {
  constructor(readonly code: DeliveryFailureCode, message: string) {
    super(message);
    this.name = "DeliveryOperationFailure";
  }
}
