import { expect, test } from "vitest";

import { parseThemePreference, resolveTheme } from "../src/frontend/components/app/theme.js";

test("theme preferences parse external storage values and resolve system preference", () => {
  expect(parseThemePreference("light")).toBe("light");
  expect(parseThemePreference("dark")).toBe("dark");
  expect(parseThemePreference("system")).toBe("system");
  expect(parseThemePreference("unknown")).toBe("system");
  expect(parseThemePreference(null)).toBe("system");
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("light", true)).toBe("light");
  expect(resolveTheme("dark", false)).toBe("dark");
});
