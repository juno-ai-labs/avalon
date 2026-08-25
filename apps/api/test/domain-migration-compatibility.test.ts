import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { compatibleDesktopDeepLink, connectorAttemptTarget } from "../src/lib/desktop-handoff";
import { AuthService } from "../src/services/auth-service";
import { __resendInboundEmailTesting } from "../src/services/resend-inbound-email-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result } from "./helpers/cloudflare-test";
import { contractCompleteEnv } from "./helpers/worker-env";

/**
 * The compatibility half of the domain migration, exercised against the
 * *deployed* scheme rather than the test default.
 *
 * Every other API test sets `DESKTOP_DEEP_LINK_URI` to the legacy scheme, which
 * is also what a shipped client sends — so client and server agree in the suite
 * and disagree only in production. These tests deliberately configure the
 * current scheme, which is the one combination that reproduces what a real
 * deploy does to a client that has not updated.
 *
 * See `docs/domain-migration.md`.
 */

const CURRENT = "rallywithai://auth/complete";
const LEGACY = "avalon://auth/complete";
const ATTEMPT = "a".repeat(43);

/** Captures whatever `beginIdentity` binds, so the stored return URI is readable. */
function identityFixture(): { env: Env; bound: () => unknown[] } {
  let bound: unknown[] = [];
  const statement: D1PreparedStatement = createTestD1PreparedStatement({
    bind: (...values: unknown[]): D1PreparedStatement => {
      bound = values;
      return statement;
    },
    run: async () => createTestD1Result({ success: true, meta: {} }),
    first: async () => null,
  });
  const env = contractCompleteEnv({
    AVALON_REGION: "global",
    DESKTOP_DEEP_LINK_URI: CURRENT,
    DB: createTestD1Database({ prepare: () => statement }),
  });
  return { env, bound: () => bound };
}

describe("desktop sign-in across the scheme rename", () => {
  it("accepts the return URI a build shipped before the rename sends", async () => {
    const { env, bound } = identityFixture();

    await new AuthService(env).beginIdentity({
      returnUri: LEGACY,
      desktopAttemptId: ATTEMPT,
      desktopCodeChallenge: ATTEMPT,
    });

    // Echoed back rather than replaced: the completion has to land in the
    // scheme the calling build actually registered with the operating system.
    expect(bound()).toContain(LEGACY);
    expect(bound()).not.toContain(CURRENT);
  });

  it("accepts the return URI a current build sends", async () => {
    const { env, bound } = identityFixture();

    await new AuthService(env).beginIdentity({
      returnUri: CURRENT,
      desktopAttemptId: ATTEMPT,
      desktopCodeChallenge: ATTEMPT,
    });

    expect(bound()).toContain(CURRENT);
  });

  it("still refuses a return URI that is not the configured destination", async () => {
    const { env } = identityFixture();

    // Widening the scheme must not widen the host or the path: those are what
    // stop an attacker naming their own destination.
    for (const returnUri of [
      "rallywithai://auth/elsewhere",
      "rallywithai://evil/complete",
      "https://evil.example/auth/complete",
    ]) {
      await expect(new AuthService(env).beginIdentity({
        returnUri,
        desktopAttemptId: ATTEMPT,
        desktopCodeChallenge: ATTEMPT,
      })).rejects.toMatchObject({ code: "invalid_return_uri" });
    }
  });
});

describe("deep links the server mints without a caller scheme", () => {
  it("uses the scheme every live build registers", () => {
    const env = contractCompleteEnv({ DESKTOP_DEEP_LINK_URI: CURRENT, AVALON_REGION: "global" });

    // Connector start carries no returnUri, so the server cannot know which
    // schemes the calling build claimed. A pre-rename build registered only the
    // legacy scheme; every build since registers both.
    expect(compatibleDesktopDeepLink(env).toString()).toBe(LEGACY);

    const target = new URL(connectorAttemptTarget(env, {
      provider: "linear",
      status: "succeeded",
      connectionId: "00000000-0000-4000-8000-000000000004",
    }));
    expect(target.protocol).toBe("avalon:");
    expect(target.searchParams.get("provider")).toBe("linear");
    expect(target.searchParams.get("status")).toBe("connected");
  });

  it("keeps the configured host and path", () => {
    const env = contractCompleteEnv({ DESKTOP_DEEP_LINK_URI: CURRENT, AVALON_REGION: "global" });
    const target = new URL(compatibleDesktopDeepLink(env).toString());

    expect(target.host).toBe("auth");
    expect(target.pathname).toBe("/complete");
  });
});

describe("the work-stream email domain a deployment mints on", () => {
  it("refuses a superseded domain rather than minting on it", () => {
    // Accepting the old domain inbound is the point of the legacy list; minting
    // new addresses on it is not, and would be silent.
    expect(() => __resendInboundEmailTesting.configuredEmailDomain("automation.with-avalon.com"))
      .toThrowError();
    expect(() => __resendInboundEmailTesting.configuredEmailDomain("automaton.rallywith.ai"))
      .toThrowError();
    expect(__resendInboundEmailTesting.configuredEmailDomain("automation.rallywith.ai"))
      .toBe("automation.rallywith.ai");
  });

  it("still routes mail addressed to the superseded domain", () => {
    const accepted = __resendInboundEmailTesting.acceptedEmailDomains("automation.rallywith.ai");

    expect(accepted.has("automation.with-avalon.com")).toBe(true);
    expect(accepted.has("automation.rallywith.ai")).toBe(true);
  });
});
