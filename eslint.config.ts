import tseslint from "typescript-eslint";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import { importX } from "eslint-plugin-import-x";

const noEnums = { selector: "TSEnumDeclaration", message: "Use an as const tuple and derive the type (see DEFINITIONS.md)." };
const noUncheckedReads = { selector: "CallExpression[callee.name='readJsonUnchecked']", message: "Call readJsonUnchecked only in a feature *-api.ts module (see AGENTS.md)." };
const noDoubleCasts = { selector: "TSAsExpression > TSAsExpression.expression > TSUnknownKeyword.typeAnnotation", message: "Do not cast through unknown. Parse the value or fix the type." };
// Files that called readJsonUnchecked directly before the rule. Move their calls into a *-api.ts module and delete the entry; do not add entries.
const legacyUncheckedReads = [
  "src/frontend/components/app/github-device-sign-in.tsx",
  "src/frontend/components/app/update-provider.tsx",
  "src/frontend/features/admin/admin.tsx",
  "src/frontend/features/admin/external-agent-actions.ts",
  "src/frontend/features/admin/external-agent-connection-guide.tsx",
  "src/frontend/features/admin/internal-agents-manager.tsx",
  "src/frontend/features/analytics/analytics.tsx",
  "src/frontend/features/auth/auth.tsx",
  "src/frontend/features/auth/oauth-consent.tsx",
  "src/frontend/features/onboarding/onboarding.ts",
  "src/frontend/features/projects/create-project-dialog.tsx",
  "src/frontend/features/projects/project-details.tsx",
  "src/frontend/features/projects/project-repository-connection.tsx",
  "src/frontend/features/projects/projects.tsx",
  "src/frontend/features/settings/backup-settings.tsx",
  "src/frontend/features/settings/company-settings.tsx",
  "src/frontend/features/settings/provider-login.tsx",
  "src/frontend/features/settings/provider-settings.tsx",
  "src/frontend/features/settings/setup.tsx",
  "src/frontend/features/settings/task-template-settings.tsx",
  "src/frontend/features/settings/trigger-settings.tsx",
  "src/frontend/features/settings/workflow-settings.tsx",
  "src/frontend/features/tasks/issue-picker.tsx",
  "src/frontend/features/tasks/lib/duplicate-task-prefill.ts",
  "src/frontend/features/tasks/lib/task-checks.ts",
  "src/frontend/features/tasks/new-task-dialog.tsx",
  "src/frontend/features/tasks/task-agent.tsx",
  "src/frontend/features/tasks/task-chat/session-history.tsx",
  "src/frontend/features/tasks/task-data.tsx",
  "src/frontend/features/tasks/task-source-picker.tsx",
  "src/frontend/features/timeline/timeline.tsx",
  "src/frontend/shell/company-context.tsx",
];

export default tseslint.config({
  ignores: ["dist/**", "src/frontend/contracts/generated/**", "node_modules/**", ".context/**", ".suplex/**", ".suplex/**", ".scratch/**", "coverage/**", "rust/target/**", "desktop/**"],
}, {
  files: ["src/frontend/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
  plugins: { "@typescript-eslint": tseslint.plugin },
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
  },
  rules: {
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "all" }],
    "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "inline-type-imports" }],
    "@typescript-eslint/no-import-type-side-effects": "error",
    "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true }],
    "no-restricted-syntax": ["error", noEnums],
  },
}, {
  files: ["src/frontend/**/*.{ts,tsx}"],
  plugins: { "import-x": importX },
  settings: { "import-x/resolver-next": [createTypeScriptImportResolver()] },
  rules: {
    "import-x/no-cycle": ["error", { maxDepth: Infinity }],
    "no-restricted-imports": ["error", { patterns: [{ group: ["node:*"], message: "Frontend code consumes HTTP contracts and browser helpers; native execution belongs to Rust." }] }],
    "no-restricted-syntax": ["error", noEnums, noUncheckedReads, noDoubleCasts],
  },
}, {
  files: ["src/frontend/**/*-api.ts", "src/frontend/lib/api.ts", ...legacyUncheckedReads],
  rules: { "no-restricted-syntax": ["error", noEnums, noDoubleCasts] },
});
