import { describe, expect, it } from "vitest";

import { assertEnvContract, EnvContractError, type Env } from "../src/env";
import { createTestEnv } from "./helpers/cloudflare-test";

function binding(): never {
  return {} as never;
}

function productionEnv(overrides: Partial<Env> = {}): Env {
  return createTestEnv({
    DB: binding(), PAYLOADS: binding(), TELEMETRY_PAYLOADS: binding(),
    IMAGES: binding(), AI: binding(), MEMORY_INDEX: binding(),
    RUN_ANALYTICS: binding(), TERMINAL_ANALYTICS: binding(), CRASH_SYMBOLICATOR: binding(),
    SUBSTREAM_AGENTS: binding(), BLOCK_DASHBOARD_AGENTS: binding(),
    WORKSTREAM_DOS: binding(), WORKSPACE_DOS: binding(),
    ACTIVITY_QUEUE: binding(),
    ACCESS_REVOCATION_QUEUE: binding(),
    CONNECTOR_POLL_WORKFLOW: binding(),
    CONNECTOR_EVENT_WORKFLOW: binding(), WORK_OPPORTUNITY_WORKFLOW: binding(),
    APP_ENV: "production",
    AVALON_REGION: "global",
    LOG_LEVEL: "info",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    ALLOWED_ORIGINS: "app://avalon",
    DESKTOP_DEEP_LINK_URI: "avalon://auth/complete",
    OPENROUTER_API_KEY: "sk-or-secret",
    OPENROUTER_PRIMARY_MODEL: "x-ai/grok-4.3",
    OPENROUTER_FALLBACK_MODELS: "google/gemini-3.6-flash",
    OPENROUTER_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_STRUCTURED_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_AUTOMATION_MODEL: "x-ai/grok-4.5",
    SESSION_SIGNING_KEY: "session-secret",
    OAUTH_STATE_ENCRYPTION_KEY: "oauth-secret",
    CONNECTOR_CREDENTIALS_KEY: "credentials-secret",
    CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    TELEMETRY_CAPABILITY_SIGNING_KEY: "telemetry-capability-secret",
    TELEMETRY_OPERATORS_JSON: JSON.stringify({
      "operator-token-at-least-thirty-two-characters": {
        operatorId: "0198a229-ef99-7000-8000-000000000001",
        role: "security",
      },
    }),
    POSTHOG_PROJECT_TOKEN: "phc_test",
    GOOGLE_OAUTH_CLIENT_ID: "google-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
    TOOL_DEFAULT_TIMEOUT_MS: "30000",
    WEB_SEARCH_MAX_RESULTS: "8",
    WEB_FETCH_MAX_BYTES: "2000000",
    MAX_ATTACHMENT_BYTES: "25000000",
    WEBHOOK_REPLAY_WINDOW_SECONDS: "300",
    CONNECTOR_POLL_TIMEOUT_MS: "20000",
    ...overrides,
  });
}

describe("environment contract", () => {
  it("accepts the production configuration", () => {
    expect(() => assertEnvContract(productionEnv())).not.toThrow();
  });

  it("refuses a malformed retry budget rather than parsing a prefix out of it", () => {
    // `countEnv` reads this key with `Number.parseInt`, which would take `1` out
    // of `"1oops"` and out of `"1.5"`. It never sees either: the contract holds
    // the key to `/^\d+$/u` and the Worker answers a 503 naming it, so a typo
    // fails loudly at boot instead of quietly enabling a retry budget nobody
    // configured. Zero is the one value that must pass — it is the operator's
    // lever for stopping the harness re-requesting into a failing provider.
    expect(() => assertEnvContract(productionEnv({ HARNESS_TRANSPORT_RETRIES: "0" }))).not.toThrow();
    expect(() => assertEnvContract(productionEnv({ HARNESS_TRANSPORT_RETRIES: "2" }))).not.toThrow();
    for (const malformed of ["1oops", "1.5", "-1", " 1", ""]) {
      expect(() => assertEnvContract(productionEnv({ HARNESS_TRANSPORT_RETRIES: malformed })))
        .toThrow(/HARNESS_TRANSPORT_RETRIES is invalid/u);
    }
  });

  it("disables Terminal gracefully when Daytona configuration is incomplete", () => {
    const incomplete = productionEnv({ TERMINAL_REGION_CAPABILITY: "supported" });
    expect(() => assertEnvContract(incomplete)).not.toThrow();

    expect(() => assertEnvContract(productionEnv({
      TERMINAL_REGION_CAPABILITY: "supported",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_API_URL: "not-a-url",
    }))).not.toThrow();

    expect(() => assertEnvContract(productionEnv({
      TERMINAL_REGION_CAPABILITY: "supported",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_API_URL: "http://daytona.example.com/api",
      DAYTONA_TARGET: "us",
      DAYTONA_TERMINAL_SNAPSHOT: "terminal-snapshot",
    }))).toThrow(/DAYTONA_API_URL is invalid/u);

    expect(() => assertEnvContract(productionEnv({
      TERMINAL_REGION_CAPABILITY: "supported",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_API_URL: "https://daytona.example.com/api",
      DAYTONA_TARGET: "us",
      DAYTONA_TERMINAL_SNAPSHOT: "terminal-snapshot",
    }))).not.toThrow();
  });

  it("allows telemetry delivery and operator access to be provisioned after collection", () => {
    const env = productionEnv();
    delete (env as Partial<Env>).POSTHOG_PROJECT_TOKEN;
    delete (env as Partial<Env>).TELEMETRY_CAPABILITY_SIGNING_KEY;
    delete (env as Partial<Env>).TELEMETRY_OPERATORS_JSON;

    expect(() => assertEnvContract(env)).not.toThrow();
  });

  it("names a missing required variable without echoing any value", () => {
    const env = productionEnv();
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
    const env = productionEnv();
    delete (env as Partial<Env>).TELEMETRY_PAYLOADS;

    expect(() => assertEnvContract(env)).toThrow(/TELEMETRY_PAYLOADS is missing/u);
  });

  it("rejects a numeric deadline that would silently fall back to its default", () => {
    expect(() => assertEnvContract(productionEnv({ CONNECTOR_POLL_TIMEOUT_MS: "20s" })))
      .toThrow(/CONNECTOR_POLL_TIMEOUT_MS is invalid/u);
  });

  it("accepts a child ceiling of zero, which `numericEnv` already reads as the default", () => {
    // Readability is the check, not policy. Zero is a value an operator may
    // legitimately set to drop a ceiling during an incident, and `numericEnv`
    // treats a non-positive value as "use the default" — so rejecting it here
    // would turn a documented mitigation into a region-wide 503.
    expect(() => assertEnvContract(productionEnv({ HARNESS_CHILD_MAX_TOOL_CALLS: "0" }))).not.toThrow();
  });

  it("says whether a key is missing or merely wrong", () => {
    // Read from the environment, not from `issue.input`, which Zod does not
    // populate — testing it reported a key that is set but malformed as
    // missing, sending whoever reads the log after a variable that is there.
    expect(() => assertEnvContract(productionEnv({ APP_ENV: "prod" as Env["APP_ENV"] })))
      .toThrow(/APP_ENV is invalid/u);
    const withoutLogLevel = productionEnv();
    delete (withoutLogLevel as Partial<Env>).LOG_LEVEL;
    expect(() => assertEnvContract(withoutLogLevel)).toThrow(/LOG_LEVEL is missing/u);
  });

  it("leaves an absent optional ceiling alone", () => {
    const env = productionEnv();
    delete (env as Partial<Env>).CONNECTOR_POLL_TIMEOUT_MS;
    expect(() => assertEnvContract(env)).not.toThrow();
  });

  it("reports every offending key at once", () => {
    const env = productionEnv({ AVALON_REGION: "us" as never, PUBLIC_API_BASE_URL: "not-a-url" });
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
    const withoutGoogle = productionEnv();
    delete (withoutGoogle as Partial<Env>).GOOGLE_OAUTH_CLIENT_ID;
    delete (withoutGoogle as Partial<Env>).GOOGLE_OAUTH_CLIENT_SECRET;

    expect(() => assertEnvContract(withoutGoogle))
      .toThrow(/GOOGLE_OAUTH_CLIENT_ID is missing, GOOGLE_OAUTH_CLIENT_SECRET is missing/u);
    // `.dev.vars` has never carried them, so requiring them locally would break
    // `pnpm dev:api:local` rather than catch a real misconfiguration.
    expect(() => assertEnvContract({ ...withoutGoogle, APP_ENV: "development" })).not.toThrow();
  });

  it("does not require the Google OAuth secrets in EU, which never carries them", () => {
    // Regression. Identity sign-in happens only through Global, so the deployed
    // EU Worker has neither key by design — and requiring them there failed its
    // contract on every request, queue batch, and cron tick, while `/health`
    // stayed exempt and went on answering `ok`.
    const eu = productionEnv({ AVALON_REGION: "eu", PUBLIC_API_BASE_URL: "https://eu.api.with-avalon.com" });
    delete (eu as Partial<Env>).GOOGLE_OAUTH_CLIENT_ID;
    delete (eu as Partial<Env>).GOOGLE_OAUTH_CLIENT_SECRET;

    expect(() => assertEnvContract(eu)).not.toThrow();
  });

  it("holds an unrecognized region to every rule, including Global's", () => {
    // The fail-closed branch. The invalid-region case above keeps both Google
    // keys, so on its own it never proves they stay required when the region
    // cannot be read — and a change that treated an unknown region like EU
    // would pass the suite without this.
    const unknown = productionEnv({ AVALON_REGION: "us" as never });
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

  it("still requires the OpenRouter key in EU, which does use it", () => {
    const eu = productionEnv({ AVALON_REGION: "eu", PUBLIC_API_BASE_URL: "https://eu.api.with-avalon.com" });
    delete (eu as Partial<Env>).GOOGLE_OAUTH_CLIENT_ID;
    delete (eu as Partial<Env>).GOOGLE_OAUTH_CLIENT_SECRET;
    delete (eu as Partial<Env>).OPENROUTER_API_KEY;

    let thrown: EnvContractError | undefined;
    try { assertEnvContract(eu); } catch (error) { thrown = error as EnvContractError; }
    expect(thrown?.keys).toEqual(["OPENROUTER_API_KEY is missing"]);
  });

  it("lets a sandbox boot without an OpenRouter key, but not a deployment", () => {
    // `scripts/seed-sandbox-env.mjs` leaves the key empty whenever no real one
    // is available, which is every sandbox session. Enforcing it unconditionally
    // turned that into a 503 on every route of both regions — including
    // `/health`, the one endpoint that models its absence as a supported state
    // and could have named it.
    const withoutKey = productionEnv();
    delete (withoutKey as Partial<Env>).OPENROUTER_API_KEY;

    expect(() => assertEnvContract(withoutKey)).toThrow(/OPENROUTER_API_KEY is missing/u);
    expect(() => assertEnvContract({ ...withoutKey, APP_ENV: "development" })).not.toThrow();
  });

  it("validates a given environment object once", () => {
    const env = productionEnv();
    assertEnvContract(env);
    // Memoised on identity, so the per-isolate cost is one parse rather than
    // one per request.
    (env as { PUBLIC_API_BASE_URL: string }).PUBLIC_API_BASE_URL = "not-a-url";
    expect(() => assertEnvContract(env)).not.toThrow();
  });
});
