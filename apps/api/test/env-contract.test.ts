import "../../../tests/isolated-region";
import { describe, expect, it } from "vitest";

import { assertEnvContract, EnvContractError, type Env } from "../src/env";
import { contractCompleteEnv } from "./helpers/worker-env";

describe("environment contract", () => {
  it("accepts the production configuration", () => {
    expect(() => assertEnvContract(contractCompleteEnv())).not.toThrow();
  });

  it("refuses a malformed retry budget rather than parsing a prefix out of it", () => {
    // `countEnv` reads this key with `Number.parseInt`, which would take `1` out
    // of `"1oops"` and out of `"1.5"`. It never sees either: the contract holds
    // the key to `/^\d+$/u` and the Worker answers a 503 naming it, so a typo
    // fails loudly at boot instead of quietly enabling a retry budget nobody
    // configured. Zero is the one value that must pass — it is the operator's
    // lever for stopping the harness re-requesting into a failing provider.
    expect(() => assertEnvContract(contractCompleteEnv({ HARNESS_TRANSPORT_RETRIES: "0" }))).not.toThrow();
    expect(() => assertEnvContract(contractCompleteEnv({ HARNESS_TRANSPORT_RETRIES: "2" }))).not.toThrow();
    for (const malformed of ["1oops", "1.5", "-1", " 1", ""]) {
      expect(() => assertEnvContract(contractCompleteEnv({ HARNESS_TRANSPORT_RETRIES: malformed })))
        .toThrow(/HARNESS_TRANSPORT_RETRIES is invalid/u);
    }
  });

  it("disables Terminal gracefully when Daytona configuration is incomplete", () => {
    const incomplete = contractCompleteEnv({ TERMINAL_REGION_CAPABILITY: "supported" });
    expect(() => assertEnvContract(incomplete)).not.toThrow();

    expect(() => assertEnvContract(contractCompleteEnv({
      TERMINAL_REGION_CAPABILITY: "supported",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_API_URL: "not-a-url",
    }))).not.toThrow();

    expect(() => assertEnvContract(contractCompleteEnv({
      TERMINAL_REGION_CAPABILITY: "supported",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_API_URL: "http://daytona.example.com/api",
      DAYTONA_TARGET: "us",
      DAYTONA_TERMINAL_SNAPSHOT: "terminal-snapshot",
    }))).toThrow(/DAYTONA_API_URL is invalid/u);

    expect(() => assertEnvContract(contractCompleteEnv({
      TERMINAL_REGION_CAPABILITY: "supported",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_API_URL: "https://daytona.example.com/api",
      DAYTONA_TARGET: "us",
      DAYTONA_TERMINAL_SNAPSHOT: "terminal-snapshot",
    }))).not.toThrow();
  });

  it("allows telemetry delivery and operator access to be provisioned after collection", () => {
    const env = contractCompleteEnv();
    delete (env as Partial<Env>).POSTHOG_PROJECT_TOKEN;
    delete (env as Partial<Env>).TELEMETRY_CAPABILITY_SIGNING_KEY;
    delete (env as Partial<Env>).TELEMETRY_OPERATORS_JSON;

    expect(() => assertEnvContract(env)).not.toThrow();
  });

  it("names a missing required variable without echoing any value", () => {
    const env = contractCompleteEnv();
    delete (env as Partial<Env>).SESSION_SIGNING_KEY;

    let thrown: unknown;
    try { assertEnvContract(env); } catch (error) { thrown = error; }

    expect(thrown).toBeInstanceOf(EnvContractError);
    expect((thrown as EnvContractError).keys).toEqual(["SESSION_SIGNING_KEY is missing"]);
    // Nearly every key here is a secret, so the message carries names and rules
    // only. A leaked value would land in Workers Logs and in Logpush.
    const message = (thrown as Error).message;
    for (const secret of ["sk-or-secret", "session-secret", "oauth-secret", "credentials-secret", "google-secret"]) {
      expect(message).not.toContain(secret);
    }
  });

  it("requires the isolated telemetry object store in production", () => {
    const env = contractCompleteEnv();
    delete (env as Partial<Env>).TELEMETRY_PAYLOADS;

    expect(() => assertEnvContract(env)).toThrow(/TELEMETRY_PAYLOADS is missing/u);
  });

  it("requires the shared artifact route database", () => {
    const env = contractCompleteEnv();
    delete (env as Partial<Env>).PLATFORM_DB;

    expect(() => assertEnvContract(env)).toThrow(/PLATFORM_DB is missing/u);
  });

  it("requires both private capability service bindings", () => {
    const withoutDocuments = contractCompleteEnv();
    delete (withoutDocuments as Partial<Env>).DOCUMENT_PROCESSOR;
    expect(() => assertEnvContract(withoutDocuments)).toThrow(/DOCUMENT_PROCESSOR is missing/u);

    const withoutTerminal = contractCompleteEnv();
    delete (withoutTerminal as Partial<Env>).TERMINAL_PROVIDER;
    expect(() => assertEnvContract(withoutTerminal)).toThrow(/TERMINAL_PROVIDER is missing/u);
  });

  it("requires telemetry delivery in hosted deployments", () => {
    const global = contractCompleteEnv() as Env & { TELEMETRY_DELIVERY?: object };
    delete global.TELEMETRY_DELIVERY;
    expect(() => assertEnvContract(global)).toThrow(/TELEMETRY_DELIVERY is missing/u);

    const staging = contractCompleteEnv({ APP_ENV: "staging" }) as Env & {
      TELEMETRY_DELIVERY?: object;
    };
    delete staging.TELEMETRY_DELIVERY;
    expect(() => assertEnvContract(staging)).toThrow(/TELEMETRY_DELIVERY is missing/u);

    const development = contractCompleteEnv({ APP_ENV: "development" }) as Env & {
      TELEMETRY_DELIVERY?: object;
    };
    delete development.TELEMETRY_DELIVERY;
    expect(() => assertEnvContract(development)).not.toThrow();

    const enterprise = contractCompleteEnv({
      AVALON_REGION: "enterprise",
      PUBLIC_API_BASE_URL: "https://enterprise.api.with-avalon.com",
    }) as Env & { TELEMETRY_DELIVERY?: object };
    delete enterprise.TELEMETRY_DELIVERY;
    delete (enterprise as Partial<Env>).GOOGLE_OAUTH_CLIENT_ID;
    delete (enterprise as Partial<Env>).GOOGLE_OAUTH_CLIENT_SECRET;
    delete (enterprise as Partial<Env>).INFERENCE_LAKEHOUSE_QUEUE;
    delete (enterprise as Partial<Env>).INFERENCE_LAKEHOUSE;
    delete (enterprise as Partial<Env>).ANALYTICS_LAKEHOUSE_QUEUE;
    delete (enterprise as Partial<Env>).ANALYTICS_LAKEHOUSE;
    expect(() => assertEnvContract(enterprise)).toThrow(/LAKEHOUSE.*missing/u);
  });

  it("requires the shared inference-pricing KV binding", () => {
    const env = contractCompleteEnv();
    delete (env as Partial<Env>).INFERENCE_PRICING_CACHE;

    expect(() => assertEnvContract(env)).toThrow(/INFERENCE_PRICING_CACHE is missing/u);
  });

  it("requires the platform-wide favicon KV binding", () => {
    const env = contractCompleteEnv();
    delete (env as Partial<Env>).FAVICON_CACHE;

    expect(() => assertEnvContract(env)).toThrow(/FAVICON_CACHE is missing/u);
  });

  it("rejects a numeric deadline that would silently fall back to its default", () => {
    expect(() => assertEnvContract(contractCompleteEnv({ CONNECTOR_POLL_TIMEOUT_MS: "20s" })))
      .toThrow(/CONNECTOR_POLL_TIMEOUT_MS is invalid/u);
  });

  it("accepts a child ceiling of zero, which `numericEnv` already reads as the default", () => {
    // Readability is the check, not policy. Zero is a value an operator may
    // legitimately set to drop a ceiling during an incident, and `numericEnv`
    // treats a non-positive value as "use the default" — so rejecting it here
    // would turn a documented mitigation into a region-wide 503.
    expect(() => assertEnvContract(contractCompleteEnv({ HARNESS_CHILD_MAX_TOOL_CALLS: "0" }))).not.toThrow();
  });

  it("says whether a key is missing or merely wrong", () => {
    // Read from the environment, not from `issue.input`, which Zod does not
    // populate — testing it reported a key that is set but malformed as
    // missing, sending whoever reads the log after a variable that is there.
    expect(() => assertEnvContract(contractCompleteEnv({ APP_ENV: "prod" as Env["APP_ENV"] })))
      .toThrow(/APP_ENV is invalid/u);
    const withoutLogLevel = contractCompleteEnv();
    delete (withoutLogLevel as Partial<Env>).LOG_LEVEL;
    expect(() => assertEnvContract(withoutLogLevel)).toThrow(/LOG_LEVEL is missing/u);
  });

  it("leaves an absent optional ceiling alone", () => {
    const env = contractCompleteEnv();
    delete (env as Partial<Env>).CONNECTOR_POLL_TIMEOUT_MS;
    expect(() => assertEnvContract(env)).not.toThrow();
  });

  it("requires the optional Azure inference endpoint and key as a pair", () => {
    expect(() => assertEnvContract(contractCompleteEnv({
      AZURE_INFERENCE_ENDPOINT: "https://monad-prod-resource.services.ai.azure.com",
      AZURE_INFERENCE_API_KEY: "azure-key",
    }))).not.toThrow();
    expect(() => assertEnvContract(contractCompleteEnv({
      AZURE_INFERENCE_ENDPOINT: "https://monad-prod-resource.services.ai.azure.com",
    }))).toThrow(/AZURE_INFERENCE_ENDPOINT and AZURE_INFERENCE_API_KEY must be configured together/u);
    expect(() => assertEnvContract(contractCompleteEnv({
      AZURE_INFERENCE_API_KEY: "azure-key",
    }))).toThrow(/AZURE_INFERENCE_ENDPOINT and AZURE_INFERENCE_API_KEY must be configured together/u);
  });

  it("rejects Azure inference endpoints the transport cannot address", () => {
    for (const endpoint of [
      "http://monad-prod-resource.services.ai.azure.com",
      "https://monad-prod-resource.services.ai.azure.com/openai/deployments/grok-4.3",
      "https://monad-prod-resource.services.ai.azure.com?api-version=preview",
    ]) {
      expect(() => assertEnvContract(contractCompleteEnv({
        AZURE_INFERENCE_ENDPOINT: endpoint,
        AZURE_INFERENCE_API_KEY: "azure-key",
      }))).toThrow(/AZURE_INFERENCE_ENDPOINT is invalid/u);
    }
  });

  it("reports every offending key at once", () => {
    const env = contractCompleteEnv({ AVALON_REGION: "us" as never, PUBLIC_API_BASE_URL: "not-a-url" });
    delete (env as Partial<Env>).OPENROUTER_API_KEY;

    let thrown: EnvContractError | undefined;
    try { assertEnvContract(env); } catch (error) { thrown = error as EnvContractError; }

    expect(thrown?.keys).toEqual([
      "AVALON_REGION is invalid",
      "OPENROUTER_API_KEY is missing",
      "PUBLIC_API_BASE_URL is invalid",
    ]);
  });

  it("requires the Google OAuth secrets in Global production, but not in development", () => {
    const withoutGoogle = contractCompleteEnv();
    delete (withoutGoogle as Partial<Env>).GOOGLE_OAUTH_CLIENT_ID;
    delete (withoutGoogle as Partial<Env>).GOOGLE_OAUTH_CLIENT_SECRET;

    expect(() => assertEnvContract(withoutGoogle))
      .toThrow(/GOOGLE_OAUTH_CLIENT_ID is missing, GOOGLE_OAUTH_CLIENT_SECRET is missing/u);
    // `.dev.vars` has never carried them, so requiring them locally would break
    // `pnpm dev:api:local` rather than catch a real misconfiguration.
    expect(() => assertEnvContract({ ...withoutGoogle, APP_ENV: "development" })).not.toThrow();
  });

  it("does not require the Google OAuth secrets in enterprise, which never carries them", () => {
    // Regression. Identity sign-in happens only through Global, so the deployed
    // enterprise Worker has neither key by design — and requiring them there failed its
    // contract on every request, queue batch, and cron tick, while `/health`
    // stayed exempt and went on answering `ok`.
    const enterprise = contractCompleteEnv({ AVALON_REGION: "enterprise", PUBLIC_API_BASE_URL: "https://enterprise.api.with-avalon.com" });
    delete (enterprise as Partial<Env>).GOOGLE_OAUTH_CLIENT_ID;
    delete (enterprise as Partial<Env>).GOOGLE_OAUTH_CLIENT_SECRET;

    expect(() => assertEnvContract(enterprise)).not.toThrow();
  });

  it("requires both lakehouse binding pairs in hosted deployments", () => {
    const global = contractCompleteEnv();
    delete (global as Partial<Env>).INFERENCE_LAKEHOUSE_QUEUE;
    delete (global as Partial<Env>).INFERENCE_LAKEHOUSE;
    expect(() => assertEnvContract(global)).toThrow(
      /INFERENCE_LAKEHOUSE is missing, INFERENCE_LAKEHOUSE_QUEUE is missing/u,
    );
    const missingAnalytics = contractCompleteEnv();
    delete (missingAnalytics as Partial<Env>).ANALYTICS_LAKEHOUSE_QUEUE;
    delete (missingAnalytics as Partial<Env>).ANALYTICS_LAKEHOUSE;
    expect(() => assertEnvContract(missingAnalytics)).toThrow(
      /ANALYTICS_LAKEHOUSE is missing, ANALYTICS_LAKEHOUSE_QUEUE is missing/u,
    );

    const enterprise = contractCompleteEnv({
      AVALON_REGION: "enterprise",
      PUBLIC_API_BASE_URL: "https://enterprise.api.with-avalon.com",
    });
    delete (enterprise as Partial<Env>).GOOGLE_OAUTH_CLIENT_ID;
    delete (enterprise as Partial<Env>).GOOGLE_OAUTH_CLIENT_SECRET;
    delete (enterprise as Partial<Env>).INFERENCE_LAKEHOUSE_QUEUE;
    delete (enterprise as Partial<Env>).INFERENCE_LAKEHOUSE;
    delete (enterprise as Partial<Env>).ANALYTICS_LAKEHOUSE_QUEUE;
    delete (enterprise as Partial<Env>).ANALYTICS_LAKEHOUSE;
    expect(() => assertEnvContract(enterprise)).toThrow(/LAKEHOUSE.*missing/u);
  });

  it("holds an unrecognized region to every rule, including Global's", () => {
    // The fail-closed branch. The invalid-region case above keeps both Google
    // keys, so on its own it never proves they stay required when the region
    // cannot be read — and a change that treated an unknown region like enterprise
    // would pass the suite without this.
    const unknown = contractCompleteEnv({ AVALON_REGION: "us" as never });
    delete (unknown as Partial<Env>).GOOGLE_OAUTH_CLIENT_ID;
    delete (unknown as Partial<Env>).GOOGLE_OAUTH_CLIENT_SECRET;

    let thrown: EnvContractError | undefined;
    try { assertEnvContract(unknown); } catch (error) { thrown = error as EnvContractError; }
    expect(thrown?.keys).toEqual([
      "AVALON_REGION is invalid",
      "GOOGLE_OAUTH_CLIENT_ID is missing",
      "GOOGLE_OAUTH_CLIENT_SECRET is missing",
    ]);
  });

  it("still requires the OpenRouter key in enterprise, which does use it", () => {
    const enterprise = contractCompleteEnv({ AVALON_REGION: "enterprise", PUBLIC_API_BASE_URL: "https://enterprise.api.with-avalon.com" });
    delete (enterprise as Partial<Env>).GOOGLE_OAUTH_CLIENT_ID;
    delete (enterprise as Partial<Env>).GOOGLE_OAUTH_CLIENT_SECRET;
    delete (enterprise as Partial<Env>).OPENROUTER_API_KEY;

    let thrown: EnvContractError | undefined;
    try { assertEnvContract(enterprise); } catch (error) { thrown = error as EnvContractError; }
    expect(thrown?.keys).toEqual(["OPENROUTER_API_KEY is missing"]);
  });

  it("lets a sandbox boot without an OpenRouter key, but not a deployment", () => {
    // `scripts/seed-sandbox-env.mjs` leaves the key empty whenever no real one
    // is available, which is every sandbox session. Enforcing it unconditionally
    // turned that into a 503 on every route of both regions — including
    // `/health`, the one endpoint that models its absence as a supported state
    // and could have named it.
    const withoutKey = contractCompleteEnv();
    delete (withoutKey as Partial<Env>).OPENROUTER_API_KEY;

    expect(() => assertEnvContract(withoutKey)).toThrow(/OPENROUTER_API_KEY is missing/u);
    expect(() => assertEnvContract({ ...withoutKey, APP_ENV: "development" })).not.toThrow();
  });

  it("requires the TypeSafe key only in hosted deployments", () => {
    const withoutKey = contractCompleteEnv();
    delete (withoutKey as Partial<Env>).TYPESAFE_API_KEY;

    expect(() => assertEnvContract(withoutKey)).toThrow(/TYPESAFE_API_KEY is missing/u);
    expect(() => assertEnvContract({ ...withoutKey, APP_ENV: "development" })).not.toThrow();
  });

  it("validates a given environment object once", () => {
    const env = contractCompleteEnv();
    assertEnvContract(env);
    // Memoised on identity, so the per-isolate cost is one parse rather than
    // one per request.
    (env as { PUBLIC_API_BASE_URL: string }).PUBLIC_API_BASE_URL = "not-a-url";
    expect(() => assertEnvContract(env)).not.toThrow();
  });
});
