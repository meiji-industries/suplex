import { expect, test } from "vitest";
import { mcpAddress } from "../features/admin/external-agent-connection-guide.js";

test("the MCP address is judged from the page that shows it", () => {
  expect(mcpAddress({ resource: "https://nstx.suplex.sh/mcp" }, "nstx.suplex.sh")).toEqual({ kind: "ready", url: "https://nstx.suplex.sh/mcp" });
  expect(mcpAddress({ resource: "http://127.0.0.1:4111/mcp" }, "localhost")).toEqual({ kind: "ready", url: "http://127.0.0.1:4111/mcp" });
  expect(mcpAddress({ resource: "http://127.0.0.1:4111/mcp" }, "nstx.suplex.sh")).toEqual({ kind: "loopback", url: "http://127.0.0.1:4111/mcp" });
  expect(mcpAddress({ resource: "http://127.0.0.1:4111/other" }, "nstx.suplex.sh")).toEqual({ kind: "not_available" });
  expect(mcpAddress(undefined, "nstx.suplex.sh")).toEqual({ kind: "not_available" });
});
