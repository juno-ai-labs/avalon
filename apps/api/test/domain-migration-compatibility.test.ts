import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import {
  compatibleDesktopDeepLink,
  connectorAttemptTarget,
  unknownConnectorAttemptFailureTarget,
} from "../src/lib/desktop-handoff";
import { addWorkspaceTarget, parseWorkspaceTarget } from "@rally/contracts/workspace-target";
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
      // The retired Sideline app's dedicated callback.
      "sideline://auth/complete",
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
  it.each(["google", "github", "granola", "linear", "notion", "slack"] as const)(
    "uses an addressed callback for a version-two %s attempt",
    (provider) => {
      const env = contractCompleteEnv({ DESKTOP_DEEP_LINK_URI: CURRENT, AVALON_REGION: "global" });

      expect(compatibleDesktopDeepLink(env).toString()).toBe(LEGACY);
      const workspaceId = "00000000-0000-7000-8000-000000000009";
      const returnUri = addWorkspaceTarget(new URL(LEGACY), { region: "global", workspaceId }).toString();

      const target = new URL(connectorAttemptTarget(env, {
        provider,
        status: "succeeded",
        connectionId: "00000000-0000-4000-8000-000000000004",
        workspaceId,
        returnUri,
      }));
      expect(target.protocol).toBe("avalon:");
      expect(target.hostname).toBe("workspace");
      expect(parseWorkspaceTarget(target)).toEqual({ region: "global", workspaceId });
      expect(target.searchParams.get("provider")).toBe(provider);
      expect(target.searchParams.get("status")).toBe("connected");
    },
  );

  it("keeps a legacy connector attempt on its exact callback shape during rollout", () => {
    const env = contractCompleteEnv({ DESKTOP_DEEP_LINK_URI: CURRENT, AVALON_REGION: "global" });
    const target = new URL(connectorAttemptTarget(env, {
      provider: "google",
      status: "denied",
      errorCode: "oauth_denied",
      workspaceId: "00000000-0000-7000-8000-000000000009",
      returnUri: LEGACY,
    }));

    expect(target.hostname).toBe("auth");
    expect(target.pathname).toBe("/complete");
    expect(target.searchParams.get("workspace")).toBeNull();
    expect(target.searchParams.get("region")).toBe("global");
  });

  it.each([
    {
      name: "success without a connection",
      input: { status: "succeeded" },
    },
    {
      name: "denial without an error",
      input: { status: "denied" },
    },
    {
      name: "failure carrying a connection",
      input: { status: "failed", errorCode: "oauth_failed", connectionId: "connection-1" },
    },
  ])("rejects an impossible connector callback: $name", ({ input }) => {
    const env = contractCompleteEnv({ DESKTOP_DEEP_LINK_URI: CURRENT, AVALON_REGION: "global" });

    expect(() => connectorAttemptTarget(env, {
      provider: "google",
      workspaceId: "00000000-0000-7000-8000-000000000009",
      returnUri: LEGACY,
      ...input,
    } as never)).toThrow("connector callback result is invalid");
  });

  it("uses an explicitly unaddressed failure only when OAuth state cannot be resolved", () => {
    const env = contractCompleteEnv({ DESKTOP_DEEP_LINK_URI: CURRENT, AVALON_REGION: "global" });
    const target = new URL(unknownConnectorAttemptFailureTarget(env, {
      provider: "github",
      errorCode: "invalid_oauth_state",
    }));

    expect(target.hostname).toBe("auth");
    expect(target.searchParams.get("workspace")).toBeNull();
    expect(target.searchParams.get("status")).toBe("failed");
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
