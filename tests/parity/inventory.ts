import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../..", import.meta.url));
const http = (await readdir(join(root, "src/http/contracts"))).filter(name => name.endsWith(".ts")).map(name => `src/http/contracts/${name}`);
const dependencies = [
  "src/coordination/advisor-report-contracts.ts", "src/coordination/coordinator-replacement-contracts.ts", "src/coordination/human-question.ts", "src/coordination/task-agent-selection-contracts.ts", "src/coordination/worker-replacement-contracts.ts", "src/coordination/workflow-contracts.ts",
  "src/profiles/agent-profile-contracts.ts", "src/projects/execution-contracts.ts", "src/projects/integration-contracts.ts", "src/projects/provider-policy-contracts.ts", "src/runtimes/harness-kind.ts", "src/runtimes/project-mcp-contracts.ts",
  "src/tasks/contracts.ts", "src/tasks/control-contracts.ts", "src/tasks/execution/contracts.ts", "src/tasks/history/contracts.ts", "src/tasks/issue-association.ts", "src/tasks/limits/contracts.ts",
];
const methods = new Set(["refine", "superRefine", "transform", "preprocess", "strict", "passthrough", "strip"]);
const entries: Array<{ file: string; line: number; column: number; kind: string }> = [];

for (const file of [...http, ...dependencies]) {
  const source = ts.createSourceFile(file, await readFile(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression, name } = node.expression;
      let kind: string | undefined;
      if (methods.has(name.text)) kind = name.text;
      if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === "z" && expression.name.text === "coerce") kind = `coerce.${name.text}`;
      if (kind) {
        const point = source.getLineAndCharacterOfPosition(node.expression.getStart(source));
        entries.push({ file, line: point.line + 1, column: point.character + 1, kind });
      }
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "preprocess") {
      const point = source.getLineAndCharacterOfPosition(node.expression.getStart(source));
      entries.push({ file, line: point.line + 1, column: point.character + 1, kind: "preprocess" });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const counts = Object.fromEntries([...new Set(entries.map(entry => entry.kind))].sort().map(kind => [kind, entries.filter(entry => entry.kind === kind).length]));
await writeFile(join(root, "tests/parity/boundaries.json"), `${JSON.stringify({ counts, entries }, null, 2)}\n`);
console.log(`Inventoried ${entries.length} syntactic boundaries across ${http.length} HTTP files and ${dependencies.length} direct schema dependencies.`);
