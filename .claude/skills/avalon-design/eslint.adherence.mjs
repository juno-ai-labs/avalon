import { readFileSync } from "node:fs";
import globals from "globals";

// Standalone lint config for the vendored Claude Design package. Deliberately
// separate from the repo's root eslint.config.mjs (and its --max-warnings=0
// gate): the vendored components/ and ui_kits/ files are Claude Design's own
// generated output, faithfully mirroring the current app's hardcoded values,
// and pre-date this check by construction — folding this into `pnpm lint`
// would fail on content nobody here wrote. Run explicitly via
// `pnpm lint:design-system` to see where the package's own prototypes (or
// anything new added under this folder) drift from its stated tokens and
// component API.
//
// `_adherence.oxlintrc.json` ships with this package despite the name: it
// targets oxlint, but its real work happens through `no-restricted-syntax`,
// a rule oxlint doesn't implement. Both restriction rules used below are
// core ESLint rules, reused verbatim from that file; `react/forbid-elements`
// is configured with an empty forbid-list there (a no-op) and isn't reused.
const adherenceRules = JSON.parse(
  readFileSync(new URL("./_adherence.oxlintrc.json", import.meta.url))
).rules;

// Flat-config `files`/`ignores` patterns below resolve against ESLint's
// basePath, which defaults to `cwd` whenever a config is loaded via
// `--config` (see eslint/lib/eslint/eslint.js) — there is no supported way
// to override that from inside the config file or via a CLI flag when
// `--config` is explicit. The `lint:design-system` script in package.json
// `cd`s into this directory before invoking ESLint so `cwd` — and therefore
// basePath — is this directory, matching what these patterns assume.

export default [
  {
    ignores: ["ui_kits/**/index.html", "assets/**", "guidelines/**"],
  },
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-restricted-imports": adherenceRules["no-restricted-imports"],
      "no-restricted-syntax": adherenceRules["no-restricted-syntax"],
    },
  },
  {
    // Self-documents as exempt: a starter scaffold with intentional raw hex/px.
    files: ["doc-page.js"],
    rules: { "no-restricted-syntax": "off" },
  },
];
