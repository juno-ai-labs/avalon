import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type * as envModule from "../src/env";
import { EnvContractError, type Env, type HonoAppEnv } from "../src/env";

/**
 * The probe reports a failing environment contract as a check. It must not do
 * the same for a defect *in* the assertion.
 *
 * `assertEnvContractOrLog` in `index.ts` rethrows anything that is not an
 * `EnvContractError`, and this route has to match: a bug there returning a
 * plausible 503 health document would hide itself behind the very endpoint an
 * operator reaches for. This file mocks the assertion, so it lives apart from
 * the tests that need the real one — `vi.mock` is hoisted per module.
 */
vi.mock("../src/env", async (importOriginal) => ({
  ...await importOriginal<typeof envModule>(),
  assertEnvContract: vi.fn(),
}));

const { assertEnvContract } = await import("../src/env");
const { healthRoutes } = await import("../src/routes/health");

async function probe(): Promise<Response> {
  const app = new Hono<HonoAppEnv>();
  app.route("/health", healthRoutes);
  return app.request("/health", undefined, {
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ ok: 1 }) }), first: async () => ({ ok: 1 }) }) },
    PAYLOADS: { list: async () => ({ objects: [] }) },
    AVALON_REGION: "global",
    APP_ENV: "production",
  } as unknown as Env);
}

describe("the health probe's environment-contract check", () => {
  it("reports the contract as satisfied when the assertion passes", async () => {
    vi.mocked(assertEnvContract).mockImplementation(() => undefined);

    const response = await probe();

    const body = await response.json() as { checks: { envContract?: { ok: boolean; message: string } } };
    expect(body.checks.envContract).toEqual({ ok: true, message: "satisfied" });
  });

  it("reports an environment contract failure as a check", async () => {
    vi.mocked(assertEnvContract).mockImplementation(() => {
      throw new EnvContractError(["SESSION_SIGNING_KEY is missing"]);
    });

    const response = await probe();

    expect(response.status).toBe(503);
    const body = await response.json() as { checks: { envContract?: { ok: boolean; message: string } } };
    // Production, so the names stay in the log rather than the body.
    expect(body.checks.envContract).toEqual({
      ok: false,
      message: "the Worker cannot serve requests; see the env_contract_failed log",
    });
  });

  it("does not dress a defect in the assertion up as one", async () => {
    vi.mocked(assertEnvContract).mockImplementation(() => {
      throw new TypeError("the assertion itself is broken");
    });

    // Hono's default handler answers 500 for an unhandled throw. What matters is
    // that the route did not answer a health document: a 503 naming checks here
    // would be the bug reporting itself as a diagnosis.
    const response = await probe();

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("envContract");
  });
});
