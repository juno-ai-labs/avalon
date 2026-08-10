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
      // It has its own adherence check — see .agents/skills/avalon-design/eslint.adherence.mjs
      // and the `lint:design-system` script — run separately from the app's quality gate.
      // Scoped to this one skill, not all of .agents/skills/, so any other
      // skill's JS still gets the app's normal linting. Ignore the real path
      // (.agents/skills/...), not the .claude/skills/... symlink through it —
      // ESLint walks the filesystem and finds files at their real location.
      ".agents/skills/avalon-design/**",
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
