import { expect, test } from "vitest";

import { nativeBrowser } from "./helpers/native-browser.js";

test.each([
  { theme: "light" as const, width: 1280 },
  { theme: "light" as const, width: 390 },
  { theme: "dark" as const, width: 1280 },
  { theme: "dark" as const, width: 390 },
])("New Task fields stay seamless and compact in $theme mode at $width px", { timeout: 45_000 }, async ({ theme, width }) => {
  const value = await nativeBrowser(width);
  const { page } = value;
  try {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`${value.base}/tasks?company=${value.company.id}`);
    await page.getByRole("button", { name: "Create task", exact: true }).click();

    const dialog = page.getByRole("dialog");
    const title = dialog.getByLabel("Task title", { exact: true });
    const description = dialog.getByLabel("Task description", { exact: true });
    await title.waitFor();

    const readStyles = (field: typeof title) => field.evaluate(element => {
      const style = getComputedStyle(element);
      const placeholder = getComputedStyle(element, "::placeholder");
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        placeholderColor: placeholder.color,
      };
    });
    const titleStyles = await readStyles(title);
    const descriptionStyles = await readStyles(description);

    expect(titleStyles).toMatchObject({ backgroundColor: "rgba(0, 0, 0, 0)", fontSize: "18px", fontWeight: "600" });
    expect(descriptionStyles).toMatchObject({ backgroundColor: "rgba(0, 0, 0, 0)", fontSize: "14px", fontWeight: "400" });
    expect(titleStyles.placeholderColor).toBe(descriptionStyles.placeholderColor);
    expect(titleStyles.placeholderColor).not.toBe(titleStyles.color);
    expect(descriptionStyles.placeholderColor).not.toBe(descriptionStyles.color);

    await title.fill("Compact field check");
    await description.fill("Typed text stays readable on the dialog surface.");
    expect(await title.evaluate(element => getComputedStyle(element).color)).toBe(titleStyles.color);
    expect(await description.evaluate(element => getComputedStyle(element).color)).toBe(descriptionStyles.color);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.screenshot({ path: `/tmp/forge-new-task-fields-${theme}-${width}.png`, fullPage: true, animations: "disabled" });
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
