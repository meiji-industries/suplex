import tseslint from "typescript-eslint";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import { importX } from "eslint-plugin-import-x";

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
  ignores: ["dist/**", "node_modules/**", ".forge/**", ".scratch/**", "coverage/**", "bb/**", "orca/**", "meiji-industries/**", "references/**", "desktop/**"],
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
    "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "inline-type-imports" }],
    "@typescript-eslint/no-import-type-side-effects": "error",
    "@typescript-eslint/switch-exhaustiveness-check": ["error", {
      considerDefaultExhaustiveForUnions: false,
      requireDefaultForNonUnion: true,
    }],
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
  files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-syntax": ["error", {
      selector: "TSEnumDeclaration",
      message: "Use an `as const` tuple and derive the type (see DEFINITIONS.md).",
    }],
  },
}, {
  files: ["src/**/*.ts"],
  plugins: {
    "import-x": importX,
  },
  settings: {
    "import-x/resolver-next": [createTypeScriptImportResolver()],
  },
  rules: {
    "import-x/no-cycle": ["error", { maxDepth: Infinity }],
  },
}, {
  files: ["src/engine/**/*.ts"],
  rules: {
    "@typescript-eslint/no-unnecessary-condition": "error",
  },
}, {
  files: ["src/engine/workflow/**/*.ts", "src/engine/activities/**/*.ts"],
  rules: {
    "no-restricted-syntax": ["error",
      {
        selector: "Literal[value=/\\bstatus\\s*(IN\\s*\\(|=\\s*')/i]",
        message: "A decision reads the owner (git, GitHub, Herdr); a row status is a receipt, not a gate. See DEFINITIONS.md.",
      },
      {
        selector: "TemplateLiteral[quasis.0.value.raw=/\\bstatus\\s*(IN\\s*\\(|=\\s*')/i]",
        message: "A decision reads the owner (git, GitHub, Herdr); a row status is a receipt, not a gate. See DEFINITIONS.md.",
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
    "src/opencode-server.ts",
    "src/process-manager.ts",
    "src/provider-readiness.ts",
    "src/runtime.ts",
    "src/self-update.ts",
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
}, {
  files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-syntax": ["error", {
      selector: "TSEnumDeclaration",
      message: "Use an `as const` tuple and derive the type (see DEFINITIONS.md).",
    }],
  },
});
