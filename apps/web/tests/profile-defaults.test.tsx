// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import type { ApiUser } from "../lib/api.js";
import { profileDefaults, useProfileDraft } from "../features/profiles/lib/profile-draft.js";

const operator: ApiUser = { id: "user_development", displayName: "Operator", username: "operator@suplex.local", avatarSeed: "operator@suplex.local", title: "", role: "admin", status: "active", companyIds: [] };

test("email supplies the initial username without replacing a custom profile", () => {
  expect(profileDefaults(operator, "adam@example.com")).toEqual({ displayName: "", username: "adam", avatarSeed: "adam", title: "" });
  expect(profileDefaults(operator, "adam+oct28@example.com").username).toBe("adam-oct28");
  expect(profileDefaults(operator, "a@example.com").username).toBe("");
  expect(profileDefaults(operator).displayName).toBe("");
  expect(profileDefaults(operator).username).toBe("");
  const custom = { ...operator, displayName: "Adam Meghji", username: "adam.m", title: "CTO", avatarSeed: "custom" };
  expect(profileDefaults(custom, "adam@example.com")).toEqual({ displayName: "Adam Meghji", username: "adam.m", title: "CTO", avatarSeed: "custom" });
  expect(profileDefaults({ ...operator, id: "another-user" }, "adam@example.com").username).toBe("operator@suplex.local");
});

test("an account response fills untouched fields without replacing edits", async () => {
  function Draft({ email }: { email?: string }) {
    const { profile, changeProfile } = useProfileDraft(operator, email);
    return <><output>{JSON.stringify(profile)}</output><button onClick={() => changeProfile({ displayName: "Adam Meghji", title: "CTO" })}>Edit</button></>;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<Draft />));
  await act(async () => container.querySelector("button")!.click());
  await act(async () => root.render(<Draft email="adam@example.com" />));
  expect(JSON.parse(container.querySelector("output")!.textContent!)).toEqual({ displayName: "Adam Meghji", username: "adam", title: "CTO", avatarSeed: "adam" });
  await act(async () => root.unmount());
});
