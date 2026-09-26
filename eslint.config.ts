import tseslint from "typescript-eslint";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import { importX } from "eslint-plugin-import-x";

export default tseslint.config({
  ignores: ["dist/**", "node_modules/**", ".context/**", ".suplex/**", ".suplex-rust/**", ".scratch/**", "coverage/**", "rust/target/**", "desktop/**"],
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
    "no-restricted-syntax": ["error", { selector: "TSEnumDeclaration", message: "Use an as const tuple and derive the type (see DEFINITIONS.md)." }],
  },
}, {
  files: ["src/frontend/**/*.{ts,tsx}"],
  plugins: { "import-x": importX },
  settings: { "import-x/resolver-next": [createTypeScriptImportResolver()] },
  rules: {
    "import-x/no-cycle": ["error", { maxDepth: Infinity }],
    "no-restricted-imports": ["error", { patterns: [{ group: ["node:*"], message: "Frontend code consumes HTTP contracts and browser helpers; native execution belongs to Rust." }] }],
  },
});
