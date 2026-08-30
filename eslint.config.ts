import tseslint from "typescript-eslint";

const droppedTables = [
  "forge_developer_execution_leases",
  "forge_developer_execution_truth",
  "forge_plan_authorizations",
  "forge_issue_governance",
  "forge_projection_integrity_findings",
  "forge_projection_invalidations",
  "forge_project_revisions",
  "forge_issue_outputs",
].join("|");

export default tseslint.config({
  ignores: ["dist/**", "node_modules/**", ".scratch/**", "coverage/**"],
}, {
  files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
  plugins: {
    "@typescript-eslint": tseslint.plugin,
  },
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    "no-restricted-imports": ["error", { paths: [
      { name: "node:child_process", message: "Run external commands through runCommand in command-runner.ts." },
      { name: "child_process", message: "Run external commands through runCommand in command-runner.ts." },
    ] }],
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "all" }],
    "@typescript-eslint/switch-exhaustiveness-check": "error",
    "no-restricted-syntax": ["error",
      {
        selector: "CallExpression[callee.object.name='JSON'][callee.property.name='parse']",
        message: "Use the json() helper from task-utils.ts instead of JSON.parse().",
      },
      {
        selector: `CallExpression[callee.object.name='db'][callee.property.name='prepare'][arguments.0.value=/${droppedTables}/]`,
        message: "Do not query a table removed by a migration.",
      },
    ],
  },
}, {
  files: [
    "src/backup.ts",
    "src/codex-lead.ts",
    "src/command-runner.ts",
    "src/forward-merge.ts",
    "src/github.ts",
    "src/process-manager.ts",
    "src/provider-readiness.ts",
    "src/runtime.ts",
    "src/tailscale.ts",
    "src/task-sources.ts",
    "tests/ci-repair-rollback.test.ts",
    "tests/github-release.real.test.ts",
    "tests/hermes-agents.browser.test.ts",
    "tests/hermes-agents.test.ts",
    "tests/hermes-tasks-api.test.ts",
    "tests/projects.browser.test.ts",
    "tests/projects.real.test.ts",
    "tests/target-base-reconciliation.real.test.ts",
    "tests/task-sources.test.ts",
  ],
  rules: {
    "no-restricted-imports": "off",
  },
}, {
  files: ["src/frontend/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-syntax": "off",
  },
}, {
  files: ["tests/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-syntax": "off",
  },
}, {
  files: ["src/task-utils.ts"],
  rules: {
    "no-restricted-syntax": ["error", {
      selector: `CallExpression[callee.object.name='db'][callee.property.name='prepare'][arguments.0.value=/${droppedTables}/]`,
      message: "Do not query a table removed by a migration.",
    }],
  },
});
