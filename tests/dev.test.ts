import { expect, test } from "vitest";

import { resolveDevPorts } from "../scripts/dev.js";

test("reserves a Conductor port block without changing standalone defaults", () => {
  expect(resolveDevPorts(undefined)).toEqual({ temporal: 7233, temporalUi: 8233 });
  expect(resolveDevPorts("55000")).toEqual({ forge: 55000, temporal: 55001, temporalUi: 55002 });
  expect(() => resolveDevPorts("65534")).toThrow(/three valid ports/);
});
