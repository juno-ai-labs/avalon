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
import { thesvgSubpathImportsRule } from "./scripts/eslint-rules/thesvg-subpath-imports.mjs";
import { noRawEntryPointCheckRule } from "./scripts/eslint-rules/no-raw-entry-point-check.mjs";
import { providerJsonSchemaComplexityRule } from "./scripts/eslint-rules/provider-json-schema-complexity.mjs";
import { requireValidatedResponseRule } from "./scripts/eslint-rules/require-validated-response.mjs";
import {
  noDirectWorkstreamsCacheWriteRule,
} from "./scripts/eslint-rules/renderer-cache-boundaries.mjs";
import { toolInputNumberBoundaryRule } from "./scripts/eslint-rules/tool-input-boundaries.mjs";
import {
  noApplicationContractTestCastRule,
  noDirectCloudflareTestCastRule,
  noProductionDoubleAssertionRule,
} from "./scripts/eslint-rules/type-assertion-boundaries.mjs";
import { durableObjectSqlStorageRule } from "./scripts/eslint-rules/durable-object-sql-storage.mjs";
import { durableObjectRegionRoutingRule } from "./scripts/eslint-rules/durable-object-region-routing.mjs";
import { durableObjectNativeRpcRule } from "./scripts/eslint-rules/durable-object-native-rpc.mjs";
import { durableObjectSyncTransactionRule } from "./scripts/eslint-rules/durable-object-sync-transaction.mjs";

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
    plugins: {
      rally: {
        rules: {
          "no-bare-zod-url": noBareZodUrlRule,
          "thesvg-subpath-imports": thesvgSubpathImportsRule,
          "no-raw-entry-point-check": noRawEntryPointCheckRule,
          "no-direct-model-env-read": noDirectModelEnvReadRule,
          "no-direct-openrouter-client": noDirectOpenRouterClientRule,
          "provider-json-schema-complexity": providerJsonSchemaComplexityRule,
          "require-inference-diagnostics": requireInferenceDiagnosticsRule,
          "require-validated-response": requireValidatedResponseRule,
          "require-inference-signal": requireInferenceSignalRule,
          "require-websocket-ticket": requireWebSocketTicketRule,
          "tool-input-number-boundary": toolInputNumberBoundaryRule,
          "no-application-contract-test-cast": noApplicationContractTestCastRule,
          "no-direct-cloudflare-test-cast": noDirectCloudflareTestCastRule,
          "no-direct-workstreams-cache-write": noDirectWorkstreamsCacheWriteRule,
          "no-production-double-assertion": noProductionDoubleAssertionRule,
          "durable-object-sql-storage": durableObjectSqlStorageRule,
          "durable-object-region-routing": durableObjectRegionRoutingRule,
          "durable-object-native-rpc": durableObjectNativeRpcRule,
          "durable-object-sync-transaction": durableObjectSyncTransactionRule,
        },
      },
    },
    rules: {
      // Repository-wide rather than scoped to scripts/: the guard is wrong
      // wherever it is written, and the two folders that need it already keep
      // separate copies of the helper that replaces it.
      "rally/no-raw-entry-point-check": "error",
      "rally/thesvg-subpath-imports": "error",
      "rally/provider-json-schema-complexity": "error",
    },
  },
  {
    files: ["apps/api/src/**/*.{ts,tsx}"],
    ignores: ["apps/api/src/lib/durable-object-namespace.ts"],
    rules: {
      "rally/durable-object-region-routing": "error",
      "rally/durable-object-native-rpc": "error",
      "rally/durable-object-sync-transaction": "error",
    },
  },
  {
    files: [
      "apps/api/src/durable-objects/**/*.ts",
      "apps/api/src/crash-symbolicator-container.ts",
      "apps/migration-tracker/src/registry.ts",
    ],
    rules: {
      "rally/durable-object-sql-storage": "error",
    },
  },
  {
    files: [
      "apps/api/src/durable-objects/**/*.ts",
      "apps/api/src/runtime/harness-run-runtime.ts",
      "apps/api/src/workflows/workstream-loop.ts",
      "apps/api/src/services/socket-service.ts",
      "apps/api/src/services/workstream-regional-effect-service.ts",
      "apps/api/src/services/workstream-runtime-database.ts",
      "apps/api/src/queues/activity-consumer.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.object.name='crypto'][callee.property.name='randomUUID']",
          message: "Use uuidV7() for Avalon-owned agent, transport, and durable-record identities.",
        },
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.object.type='MemberExpression'][callee.object.object.name='globalThis'][callee.object.property.name='crypto'][callee.property.name='randomUUID']",
          message: "Use uuidV7() for Avalon-owned agent, transport, and durable-record identities.",
        },
        {
          selector: "VariableDeclarator[id.type='ObjectPattern'][init.name='crypto'] Property[key.name='randomUUID']",
          message: "Do not destructure crypto.randomUUID(); use uuidV7() for Avalon-owned identities.",
        },
        {
          selector: "VariableDeclarator[id.type='ObjectPattern'][init.type='MemberExpression'][init.object.name='globalThis'][init.property.name='crypto'] Property[key.name='randomUUID']",
          message: "Do not destructure globalThis.crypto.randomUUID(); use uuidV7() for Avalon-owned identities.",
        },
      ],
    },
  },
  {
    ignores: ["packages/contracts/src/url-schemas.ts"],
    rules: {
      "rally/no-bare-zod-url": "error",
    },
  },
  {
    files: ["apps/api/src/**/*.{ts,tsx}"],
    ignores: ["apps/api/src/services/structured-inference.ts"],
    rules: {
      "rally/no-direct-openrouter-client": "error",
    },
  },
  {
    files: ["apps/api/src/routes/**/*.ts"],
    rules: {
      "rally/require-validated-response": "error",
    },
  },
  {
    files: ["apps/api/src/**/*.{ts,tsx}"],
    ignores: [
      "apps/api/src/routes/health.ts",
      "apps/api/src/services/agent-model-flags.ts",
    ],
    rules: {
      "rally/no-direct-model-env-read": "error",
    },
  },
  {
    files: ["apps/api/src/services/structured-inference.ts"],
    rules: {
      "rally/require-inference-diagnostics": "error",
      "rally/require-inference-signal": "error",
    },
  },
  {
    // `authorizedConnection` mints the brand that lets a connection reach a
    // provider. Only the credential door has actually refreshed the
    // credentials by that point, so it is the only module allowed to say so.
    files: ["apps/api/src/**/*.{ts,tsx}"],
    ignores: [
      "apps/api/src/services/connector-connection-access.ts",
      "**/*.test.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@rally/connectors",
              importNames: ["authorizedConnection"],
              message: "Reach an adapter through withAuthorizedConnection; it is what refreshes the credentials this brand asserts are fresh.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/agent-harness/src/bind-runtime.ts"],
    rules: {
      "rally/require-inference-signal": "error",
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "rally/require-websocket-ticket": "error",
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"],
    ignores: ["apps/desktop/src/renderer/lib/workstreams-cache.ts"],
    rules: {
      "rally/no-direct-workstreams-cache-write": "error",
    },
  },
  {
    files: [
      "apps/**/src/**/*.{ts,tsx}",
      "packages/**/src/**/*.{ts,tsx}",
    ],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "rally/no-production-double-assertion": "error",
    },
  },
  {
    files: [
      "apps/**/*.test.{ts,tsx}",
      "apps/**/test/**/*.{ts,tsx}",
      "apps/**/test-workers/**/*.{ts,tsx}",
      "packages/**/*.test.{ts,tsx}",
      "packages/**/test/**/*.{ts,tsx}",
    ],
    ignores: [
      "apps/api/test/helpers/cloudflare-test.ts",
      "apps/ace/test/helpers/cloudflare-test.ts",
      "apps/migration-tracker/test/helpers/cloudflare-test.ts",
      "apps/release-retention/test/helpers/cloudflare-test.ts",
    ],
    rules: {
      "rally/no-application-contract-test-cast": "error",
      "rally/no-direct-cloudflare-test-cast": "error",
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
      "apps/migration-tracker/src/**/*.ts",
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
    files: [
      "apps/**/src/**/*.{ts,tsx}",
      "packages/**/src/**/*.{ts,tsx}",
    ],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "rally/tool-input-number-boundary": "error",
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
          message: "@rally/agent-harness is workerd-portable; configuration must arrive through explicit inputs.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@rally/db", "@rally/connectors", "**/apps/api/**"],
              message: "@rally/agent-harness must remain independent of database and API implementations; inject a port instead.",
            },
            {
              group: ["node:*", "fs", "fs/*", "path", "os", "child_process", "worker_threads"],
              message: "@rally/agent-harness must remain portable to Cloudflare workerd; inject runtime-specific capabilities.",
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
