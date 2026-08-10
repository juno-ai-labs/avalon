import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-*/**",
      "**/out/**",
      "**/release/**",
      "**/.wrangler/**",
      "**/.playwright-cli/**",
      "**/output/**",
      "**/coverage/**",
      // Vendored Claude Design reference package, not application source.
      // It has its own adherence check — see .claude/skills/avalon-design/eslint.adherence.mjs
      // and the `lint:design-system` script — run separately from the app's quality gate.
      ".claude/skills/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: globals.node }
  },
  {
    files: ["apps/desktop/native/*.js"],
    languageOptions: {
      globals: {
        $: "readonly",
        ObjC: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "^run$" }]
    }
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "off"
    }
  },
  {
    files: ["apps/api/src/mappers/**/*.ts"],
    rules: {
      "@typescript-eslint/explicit-function-return-type": "error"
    }
  }
);
