import { describe, expect, test } from "vitest";

import { buttonVariants } from "../src/frontend/components/ui/button.js";
import { cn } from "../src/frontend/lib/utils.js";

const radiusClasses = (className: string): string[] => className.split(/\s+/).filter(token => /(^|:)rounded(-|$)/.test(token));

describe("control radius", () => {
  test("every button variant and size uses only the control radius", () => {
    for (const variant of ["default", "outline", "secondary", "ghost", "destructive", "link"] as const) {
      for (const size of ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"] as const) {
        expect(radiusClasses(buttonVariants({ variant, size }))).toEqual(["rounded-control"]);
      }
    }
  });

  test("a call-site radius replaces the control radius", () => {
    expect(cn("rounded-control", "rounded-full")).toBe("rounded-full");
    expect(cn("rounded-md", "rounded-control")).toBe("rounded-control");
  });
});
