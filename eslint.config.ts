import tseslint from "typescript-eslint";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import { importX } from "eslint-plugin-import-x";

const noEnums = { selector: "TSEnumDeclaration", message: "Use an as const tuple and derive the type." };
const noUncheckedReads = { selector: "CallExpression[callee.name='readJsonUnchecked']", message: "Call readJsonUnchecked only in a feature *-api.ts module (see AGENTS.md)." };
const noDoubleCasts = { selector: "TSAsExpression > TSAsExpression.expression > TSUnknownKeyword.typeAnnotation", message: "Do not cast through unknown. Parse the value or fix the type." };
// Files that called readJsonUnchecked directly before the rule. Move their calls into a *-api.ts module and delete the entry; do not add entries.
const legacyUncheckedReads = [
  "apps/web/components/app/github-device-sign-in.tsx",
  "apps/web/components/app/update-provider.tsx",
  "apps/web/features/admin/admin.tsx",
  "apps/web/features/admin/external-agent-actions.ts",
  "apps/web/features/admin/external-agent-connection-guide.tsx",
  "apps/web/features/admin/internal-agents-manager.tsx",
  "apps/web/features/analytics/analytics.tsx",
  "apps/web/features/auth/auth.tsx",
  "apps/web/features/auth/oauth-consent.tsx",
  "apps/web/features/onboarding/onboarding.ts",
  "apps/web/features/projects/create-project-dialog.tsx",
  "apps/web/features/projects/project-details.tsx",
  "apps/web/features/projects/project-repository-connection.tsx",
  "apps/web/features/projects/projects.tsx",
  "apps/web/features/settings/backup-settings.tsx",
  "apps/web/features/settings/company-settings.tsx",
  "apps/web/features/settings/provider-login.tsx",
  "apps/web/features/settings/provider-settings.tsx",
  "apps/web/features/settings/setup.tsx",
  "apps/web/features/settings/task-template-settings.tsx",
  "apps/web/features/settings/trigger-settings.tsx",
  "apps/web/features/settings/workflow-settings.tsx",
  "apps/web/features/tasks/issue-picker.tsx",
  "apps/web/features/tasks/lib/duplicate-task-prefill.ts",
  "apps/web/features/tasks/lib/task-checks.ts",
  "apps/web/features/tasks/new-task-dialog.tsx",
  "apps/web/features/tasks/task-agent.tsx",
  "apps/web/features/tasks/task-chat/session-history.tsx",
  "apps/web/features/tasks/task-data.tsx",
  "apps/web/features/tasks/task-source-picker.tsx",
  "apps/web/features/timeline/timeline.tsx",
  "apps/web/shell/company-context.tsx",
];

export default tseslint.config({
  ignores: ["dist/**", "apps/web/dist/**", "apps/web/contracts/generated/**", "node_modules/**", ".claude/**", ".context/**", ".suplex/**", ".scratch/**", "coverage/**", "target/**", "apps/desktop/**", "apps/mobile/src-tauri/gen/**"],
}, {
  files: ["apps/web/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
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
  files: ["apps/web/**/*.{ts,tsx}"],
  // Tooling configs and tests run in Node.
  ignores: ["apps/web/*.config.ts", "apps/web/tests/**"],
  plugins: { "import-x": importX },
  settings: { "import-x/resolver-next": [createTypeScriptImportResolver()] },
  rules: {
    "import-x/no-cycle": ["error", { maxDepth: Infinity }],
    "no-restricted-imports": ["error", { patterns: [{ group: ["node:*"], message: "Frontend code consumes HTTP contracts and browser helpers; native execution belongs to Rust." }] }],
    "no-restricted-syntax": ["error", noEnums, noUncheckedReads, noDoubleCasts],
  },
}, {
  files: ["apps/web/**/*-api.ts", "apps/web/lib/api.ts", ...legacyUncheckedReads],
  rules: { "no-restricted-syntax": ["error", noEnums, noDoubleCasts] },
});
