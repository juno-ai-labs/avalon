import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import {
  noDirectModelEnvReadRule,
  noDirectOpenRouterClientRule,
  requireInferenceDiagnosticsRule,
  requireInferenceSignalRule,
  requireWebSocketTicketRule,
} from "./scripts/eslint-rules/inference-boundaries.mjs";
import { noBareZodUrlRule } from "./scripts/eslint-rules/no-bare-zod-url.mjs";
import { noRawEntryPointCheckRule } from "./scripts/eslint-rules/no-raw-entry-point-check.mjs";
import { providerJsonSchemaComplexityRule } from "./scripts/eslint-rules/provider-json-schema-complexity.mjs";

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
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["packages/contracts/src/url-schemas.ts"],
    plugins: {
      avalon: {
        rules: {
          "no-bare-zod-url": noBareZodUrlRule,
          "no-raw-entry-point-check": noRawEntryPointCheckRule,
          "no-direct-model-env-read": noDirectModelEnvReadRule,
          "no-direct-openrouter-client": noDirectOpenRouterClientRule,
          "provider-json-schema-complexity": providerJsonSchemaComplexityRule,
          "require-inference-diagnostics": requireInferenceDiagnosticsRule,
          "require-inference-signal": requireInferenceSignalRule,
          "require-websocket-ticket": requireWebSocketTicketRule,
        },
      },
    },
    rules: {
      "avalon/no-bare-zod-url": "error",
      // Repository-wide rather than scoped to scripts/: the guard is wrong
      // wherever it is written, and the two folders that need it already keep
      // separate copies of the helper that replaces it.
      "avalon/no-raw-entry-point-check": "error",
      "avalon/provider-json-schema-complexity": "error",
    },
  },
  {
    files: ["apps/api/src/**/*.{ts,tsx}"],
    ignores: ["apps/api/src/services/structured-inference.ts"],
    rules: {
      "avalon/no-direct-openrouter-client": "error",
    },
  },
  {
    files: ["apps/api/src/**/*.{ts,tsx}"],
    ignores: [
      "apps/api/src/routes/health.ts",
      "apps/api/src/services/agent-model-flags.ts",
    ],
    rules: {
      "avalon/no-direct-model-env-read": "error",
    },
  },
  {
    files: ["apps/api/src/services/structured-inference.ts"],
    rules: {
      "avalon/require-inference-diagnostics": "error",
      "avalon/require-inference-signal": "error",
    },
  },
  {
    files: ["packages/agent-harness/src/bind-runtime.ts"],
    rules: {
      "avalon/require-inference-signal": "error",
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "avalon/require-websocket-ticket": "error",
    },
  },
  {
    // Everything a Worker logs reaches Workers Logs, which indexes a logged
    // object's properties as queryable fields and lists `message` as the row
    // summary. A bare `console` call satisfies neither reliably, so the two
    // structured loggers own the only calls in either Worker — each one an
    // explicit `eslint-disable` at the line that emits.
    // `apps/site` is the fourth Worker and has no logger of its own: it serves
    // static assets and logs nothing. The rule holds the line there rather than
    // waiting for the first bare `console` call to need migrating.
    files: [
      "apps/api/src/**/*.ts",
      "apps/release-retention/src/**/*.ts",
      "apps/site/src/**/*.ts",
    ],
    rules: {
      "no-console": "error",
    },
  },
  {
    // The desktop client logs to a terminal or DevTools rather than to Workers
    // Logs, but the same rule holds: a diagnostic goes through the logger, which
    // owns the scope tag and the level.
    files: ["apps/desktop/src/**/*.{ts,tsx}"],
    rules: {
      "no-console": "error",
    },
  },
  {
    files: ["packages/agent-harness/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "process",
          message: "@avalon/agent-harness is workerd-portable; configuration must arrive through explicit inputs.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@avalon/db", "@avalon/connectors", "**/apps/api/**"],
              message: "@avalon/agent-harness must remain independent of database and API implementations; inject a port instead.",
            },
            {
              group: ["node:*", "fs", "fs/*", "path", "os", "child_process", "worker_threads"],
              message: "@avalon/agent-harness must remain portable to Cloudflare workerd; inject runtime-specific capabilities.",
            },
          ],
        },
      ],
    },
  },
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
