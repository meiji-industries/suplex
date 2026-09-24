import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { buttonVariants } from "../src/frontend/components/ui/button.js";
import { cn } from "../src/frontend/lib/utils.js";

const radiusClasses = (className: string): string[] => className.split(/\s+/).filter(token => /(^|:)rounded(-|$)/.test(token));
const source = (name: string): string => readFileSync(new URL(`../src/frontend/${name}`, import.meta.url), "utf8");

describe("control radius", () => {
  test("every button variant and size uses only the control radius", () => {
    for (const variant of ["default", "outline", "secondary", "ghost", "destructive", "link"] as const) {
      for (const size of ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"] as const) {
        expect(radiusClasses(buttonVariants({ variant, size }))).toEqual(["rounded-control"]);
      }
    }
  });

  test("single-line controls are pills and multi-line controls use the field radius", () => {
    expect(source("styles.css")).toContain("--radius-control: calc(infinity * 1px);");
    expect(source("styles.css")).toMatch(/--radius-field: \d/);
    for (const name of ["input.tsx", "select.tsx", "input-group.tsx", "questionnaire.tsx"]) expect(source(`components/ui/${name}`)).toContain(" rounded-control ");
    expect(source("components/ui/textarea.tsx")).toContain(" rounded-field ");
    expect(source("components/ui/textarea.tsx")).not.toContain("rounded-control");
    expect(source("components/ui/input-group.tsx")).toContain("has-[>textarea]:rounded-field");
  });

  test("a call-site radius replaces the control and field radii", () => {
    expect(cn("rounded-control", "rounded-full")).toBe("rounded-full");
    expect(cn("rounded-md", "rounded-control")).toBe("rounded-control");
    expect(cn("rounded-control", "rounded-field")).toBe("rounded-field");
  });
});
