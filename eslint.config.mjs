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
import { noDynamicImportRule } from "./scripts/eslint-rules/no-dynamic-import.mjs";
import { noInlineErrorsRule } from "./scripts/eslint-rules/no-inline-errors.mjs";
import { preferZodDirectObjectRule } from "./scripts/eslint-rules/prefer-zod-direct-object.mjs";
import { thesvgSubpathImportsRule } from "./scripts/eslint-rules/thesvg-subpath-imports.mjs";
import { noRawEntryPointCheckRule } from "./scripts/eslint-rules/no-raw-entry-point-check.mjs";
import { providerJsonSchemaComplexityRule } from "./scripts/eslint-rules/provider-json-schema-complexity.mjs";
import { requireValidatedResponseRule } from "./scripts/eslint-rules/require-validated-response.mjs";
import {
  noDiagnosticMessageInPresentationRule,
  presentationBoundaryFiles,
  presentationBoundaryIgnores,
} from "./scripts/eslint-rules/presentation-boundaries.mjs";
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
import { durableObjectWorkspaceTableRoutingRule } from "./scripts/eslint-rules/durable-object-workspace-table-routing.mjs";

export default tseslint.config(
  {
    ignores: [
      // Nested agent worktrees are independent checkouts with their own config.
      "**/.claude/worktrees/**",
      "**/dist/**",
      "**/dist-*/**",
      "**/out/**",
      "**/release/**",
      "**/.wrangler/**",
      "**/.playwright-cli/**",
      "**/output/**",
      "**/coverage/**",
      // Classic browser scripts for the motion-film skill share globals across
      // files by design (file:// pages cannot load ES modules); not app code.
      ".agents/skills/rally-motion/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  {
    plugins: {
      rally: {
        rules: {
          "no-bare-zod-url": noBareZodUrlRule,
          "no-dynamic-import": noDynamicImportRule,
          "no-inline-errors": noInlineErrorsRule,
          "prefer-zod-direct-object": preferZodDirectObjectRule,
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
          "no-diagnostic-message-in-presentation": noDiagnosticMessageInPresentationRule,
          "no-production-double-assertion": noProductionDoubleAssertionRule,
          "durable-object-sql-storage": durableObjectSqlStorageRule,
          "durable-object-region-routing": durableObjectRegionRoutingRule,
          "durable-object-native-rpc": durableObjectNativeRpcRule,
          "durable-object-sync-transaction": durableObjectSyncTransactionRule,
          "durable-object-workspace-table-routing": durableObjectWorkspaceTableRoutingRule,
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
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}", "apps/browser/src/**/*.{ts,tsx}", "packages/ui/src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: { "rally/no-inline-errors": "error" },
  },
  {
    // Sidebar and rail components own their failure language. Exceptions and
    // API diagnostics stay available to telemetry, but never become UI copy.
    files: presentationBoundaryFiles,
    ignores: presentationBoundaryIgnores,
    rules: {
      "rally/no-diagnostic-message-in-presentation": "error",
    },
  },
  {
    // These four source trees contain the regional API Worker and its Zod-owning
    // production dependencies. Avoid making a startup-reachable object schema
    // allocate a second mode-specific schema.
    files: [
      "apps/api/src/**/*.{ts,tsx}",
      "packages/agent-harness/src/**/*.{ts,tsx}",
      "packages/connectors/src/**/*.{ts,tsx}",
      "packages/contracts/src/**/*.{ts,tsx}",
    ],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "rally/prefer-zod-direct-object": "error",
    },
  },
  {
    // A Worker, renderer, or main-process request must never discover a module
    // for the first time. Legacy test and operator-script imports are migration
    // debt recorded in docs/coding-practices-and-style.md; production source
    // has no exception.
    files: [
      "apps/**/src/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
      "packages/**/src/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
    ],
    ignores: ["**/*.test.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"],
    rules: {
      "rally/no-dynamic-import": "error",
    },
  },
  {
    // The only type-aware block in the tree, and it carries the rule that needs
    // the types in the same object deliberately — one `files` glob, so widening
    // the rule's scope widens its type information in the same edit.
    //
    // `projectService` opens each linted file in a TypeScript language service,
    // which loads that file's whole tsconfig program — every `.d.ts` its types
    // reach, for the life of the process. Nothing releases a program once it is
    // open, so a repo-wide `projectService` costs the *sum* of every package's
    // program: measured at 4.7 GB of peak resident memory on a cold
    // single-threaded run, against 0.9 GB with no type information at all.
    //
    // `rally/durable-object-sync-transaction` is what needs it. It asks the
    // checker whether a callback handed to a synchronous Durable Object
    // transaction returns a Promise, which the callee's own signature decides
    // rather than this file's syntax. The other two rules here are syntactic and
    // ride along because they share the scope.
    //
    // **Enabling a type-aware rule anywhere else means giving those files a
    // `projectService` too.** A `@typescript-eslint` type-aware rule says so —
    // `getParserServices` throws when no program is available — and
    // `durable-object-sync-transaction` was changed to throw for the same reason
    // rather than quietly passing every file it cannot type.
    files: ["apps/api/src/**/*.{ts,tsx}"],
    ignores: ["apps/api/src/lib/durable-object-namespace.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
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
    // A Durable Object's `this.env.DB` is regional D1, which does not have the
    // WorkspaceDO tables; the rule reads that list from its TypeScript source.
    files: ["apps/api/src/durable-objects/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "rally/durable-object-workspace-table-routing": "error",
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
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}", "packages/ui/src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "rally/require-websocket-ticket": "error",
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
    files: ["apps/desktop/src/**/*.{ts,tsx}", "packages/ui/src/**/*.{ts,tsx}"],
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
      globals: { ...globals.browser, ...globals.node }
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
