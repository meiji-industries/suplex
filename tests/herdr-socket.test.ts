import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { connectHerdrSocket } from "../src/herdr-socket.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((fn) => fn())); });

describe("Herdr socket", () => {
  it("requests, receives events, errors, and reports close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-herdr-"));
    const path = join(directory, "herdr.sock");
    const server = net.createServer((client) => client.on("data", (buffer) => {
      for (const line of buffer.toString().trim().split("\n")) {
        const request = JSON.parse(line) as { id: string; method: string };
        if (request.method === "ping") client.write(`${JSON.stringify({ id: request.id, result: "pong" })}\n`);
        else if (request.method === "bad") client.write(`${JSON.stringify({ id: request.id, error: { code: "bad_request", message: "No" } })}\n`);
        else { client.write(`${JSON.stringify({ id: request.id, result: {} })}\n`); client.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "one" } })}\n`); client.write(`${JSON.stringify({ event: "pane.closed", data: { pane_id: "one" } })}\n`); client.end(); }
      }
    }));
    await new Promise<void>((resolve) => server.listen(path, resolve));
    cleanup.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
    const socket = await connectHerdrSocket(path);
    await expect(socket.request("ping", {})).resolves.toBe("pong");
    await expect(socket.request("bad", {})).rejects.toThrow("bad_request: No");
    const events: string[] = [];
    await socket.subscribe([{ event: "pane.agent_status_changed" }], (event) => events.push(event.event));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events).toEqual(["pane.agent_status_changed", "pane.closed", "socket_closed"]);
  });
});
