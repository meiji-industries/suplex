import { randomUUID } from "node:crypto";
import { z } from "zod";

import { UpdateResponseSchema, UpdateRestartResponseSchema, type UpdateResponse, type UpdateRestartResponse } from "../../http/contracts/update.js";

type ParentRequest = { kind: "update:read"; requestId: string; check: boolean } | { kind: "update:apply"; requestId: string };
const ParentResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("update:read-result"), requestId: z.string(), value: z.unknown() }).strict(),
  z.object({ kind: z.literal("update:apply-result"), requestId: z.string(), value: z.unknown() }).strict(),
  z.object({ kind: z.literal("update:error"), requestId: z.string(), error: z.string() }).strict(),
]);
type PendingRequest = { expected: "update:read-result" | "update:apply-result"; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };

export class SupervisorUpdateClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messageListener = (message: unknown): void => this.receive(message);
  private readonly disconnectListener = (): void => this.rejectPending("Forge update control stopped.");

  constructor() {
    process.on("message", this.messageListener);
    process.on("disconnect", this.disconnectListener);
  }

  get supported(): boolean { return typeof process.send === "function" && process.connected; }

  async read(check: boolean): Promise<UpdateResponse> {
    if (!this.supported) return { status: { kind: "failed", action: "check", message: "Forge update control is not available.", error: "Start Forge with the Forge supervisor." }, canRestart: false };
    return UpdateResponseSchema.parse(await this.request({ kind: "update:read", requestId: randomUUID(), check }));
  }

  async apply(): Promise<UpdateRestartResponse> {
    if (!this.supported) throw new Error("Forge update control is not available.");
    return UpdateRestartResponseSchema.parse(await this.request({ kind: "update:apply", requestId: randomUUID() }));
  }

  close(): void {
    process.off("message", this.messageListener);
    process.off("disconnect", this.disconnectListener);
    this.rejectPending("Forge update control stopped.");
  }

  private request(message: ParentRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.requestId);
        reject(new Error("Forge update control did not answer."));
      }, 35_000);
      const expected = message.kind === "update:read" ? "update:read-result" : "update:apply-result";
      this.pending.set(message.requestId, { expected, resolve, reject, timer });
      process.send?.(message, (error) => {
        if (!error) return;
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);
        pending.reject(error);
      });
    });
  }

  private receive(message: unknown): void {
    const parsed = ParentResponseSchema.safeParse(message);
    if (!parsed.success) return;
    const response = parsed.data;
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    if (response.kind !== "update:error" && response.kind !== pending.expected) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    if (response.kind === "update:error") pending.reject(new Error(response.error));
    else if (response.kind === "update:read-result" || response.kind === "update:apply-result") pending.resolve(response.value);
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}
