import { afterEach, expect, test, vi } from "vitest";
import { BitbucketClient } from "../src/integrations/bitbucket.js";

afterEach(() => vi.unstubAllEnvs());
const connection = { kind: "bitbucket" as const, tokenEnvironment: "TEST_BB_TOKEN" };

test("Bitbucket recovers a lost upload response by hashing remote bytes without forwarding credentials", async () => {
  vi.stubEnv("TEST_BB_TOKEN", "fixture");
  let uploaded = false;
  let writes = 0;
  const bytes = Buffer.from("image");
  const request = vi.fn<typeof fetch>(async (input, options) => {
    const url = new URL(String(input));
    if (options?.method === "POST") { uploaded = true; writes++; throw new Error("Response lost"); }
    if (url.searchParams.has("pagelen")) return Response.json({ values: uploaded ? [{ name: "suplex-task.png", size: bytes.length }] : [] });
    if (url.hostname === "api.bitbucket.org") {
      expect(options?.headers).toMatchObject({ Authorization: "Bearer fixture" });
      return new Response(null, { status: 302, headers: { location: "https://bbuseruploads.s3.amazonaws.com/object?signature=fixture" } });
    }
    expect(options?.headers).not.toHaveProperty("Authorization");
    expect(options?.redirect).toBe("manual");
    return new Response(bytes);
  });
  const client = new BitbucketClient(connection, request);
  await expect(client.upload("owner/repo", "suplex-task.png", bytes, "image/png")).rejects.toThrow("Response lost");
  expect(await client.upload("owner/repo", "suplex-task.png", bytes, "image/png")).toBe("https://bitbucket.org/owner/repo/downloads/suplex-task.png");
  expect(writes).toBe(1);
});

test("Bitbucket rejects same-size altered Downloads content", async () => {
  vi.stubEnv("TEST_BB_TOKEN", "fixture");
  const request = vi.fn<typeof fetch>(async input => String(input).includes("pagelen") ? Response.json({ values: [{ name: "suplex-task.png", size: 5 }] }) : new Response("wrong"));
  await expect(new BitbucketClient(connection, request).upload("owner/repo", "suplex-task.png", Buffer.from("image"), "image/png")).rejects.toThrow("does not match");
});

test("Bitbucket refuses untrusted download redirects before requesting them", async () => {
  vi.stubEnv("TEST_BB_TOKEN", "fixture");
  const request = vi.fn<typeof fetch>(async input => String(input).includes("pagelen") ? Response.json({ values: [{ name: "suplex-task.png", size: 5 }] }) : new Response(null, { status: 302, headers: { location: "https://attacker.example/object" } }));
  await expect(new BitbucketClient(connection, request).upload("owner/repo", "suplex-task.png", Buffer.from("image"), "image/png")).rejects.toThrow("unsafe download URL");
  expect(request).toHaveBeenCalledTimes(2);
});
