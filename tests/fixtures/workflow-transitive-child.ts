import { readFileSync } from "node:fs";

export const forbiddenChildValue = readFileSync("/tmp/forbidden-workflow-fixture", "utf8");
