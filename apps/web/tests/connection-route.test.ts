import { expect, test } from "vitest";
import { connectionRoute } from "../components/app/system-health.js";

test("connection route names how the window reaches Suplex", () => {
  expect(connectionRoute("http://localhost:4111")).toBe("This computer");
  expect(connectionRoute("http://127.0.0.1:4111")).toBe("This computer");
  expect(connectionRoute("https://meiji.tail1234.ts.net:4111")).toBe("Tailscale (Serve, HTTPS)");
  expect(connectionRoute("http://meiji.tail1234.ts.net:4111")).toBe("Tailscale (direct, HTTP)");
  expect(connectionRoute("https://suplex.example.com")).toBe("HTTPS");
  expect(connectionRoute("")).toBe("Not available");
});
