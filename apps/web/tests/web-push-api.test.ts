import { expect, test } from "vitest";

import { base64UrlToBytes } from "../features/profiles/lib/web-push-api.js";

test("decodes base64url keys with and without padding", () => {
  expect([...base64UrlToBytes("-_8")]).toEqual([251, 255]);
  expect([...base64UrlToBytes("-_8=")]).toEqual([251, 255]);
  expect([...base64UrlToBytes("BTBZMqHH6r4Tts7J_aSIgg")]).toHaveLength(16);
  expect(base64UrlToBytes("")).toHaveLength(0);
});
