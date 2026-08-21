/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runInventorySweep } from "../src/index";
import { envWithSweepCredentials } from "./helpers/cloudflare-test";

/**
 * The credentials guard in `runInventorySweep`.
 *
 * This is the one path in the subsystem that was wrong in production for its
 * whole life: `CLOUDFLARE_ACCOUNT_ID` shipped empty, the guard returned on every
 * hourly tick, and the tracker only ever learned about objects that had woken
 * and reported — 7 of roughly 811. Nothing failed, nothing was red, and the site
 * looked complete while showing under one percent of the fleet.
 *
 * A guard that silently does nothing is exactly the shape of code that needs a
 * test, because its correct behaviour and its broken behaviour are both "no
 * error". These assert on whether the sweep *reached the network*, which is the
 * only externally visible difference between the two.
 */
describe("runInventorySweep credentials guard", () => {
  /**
   * Counts calls rather than throwing on them. A throwing double proves nothing
   * here: `sweepInventory` catches its own errors and turns them into a
   * `failed` sweep, so the throw would be swallowed and the assertion would pass
   * whether or not the guard did anything. Only "was the network touched"
   * distinguishes a skip from a sweep that ran and failed.
   */
  function countingFetcher(): { fetcher: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      fetcher: async (input) => {
        calls.push(String(input));
        return Response.json({ success: true, result: [], result_info: { page: 1, total_pages: 1 } });
      },
    };
  }

  it.each([
    ["neither is set", {}],
    ["the account id is empty", { accountId: "", apiToken: "token" }],
    ["the token is empty", { accountId: "account", apiToken: "" }],
    // Whitespace counts as absent: the guard trims, and a variable set to a
    // stray space is a configuration mistake rather than a credential.
    ["a value is only whitespace", { accountId: "   ", apiToken: "token" }],
  ])("makes no request at all when %s", async (unused, credentials) => {
    const { fetcher, calls } = countingFetcher();

    await expect(
      runInventorySweep(envWithSweepCredentials(env, credentials), fetcher),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([]);
  });

  /**
   * The other half, and the reason the tests above are not vacuous: a guard that
   * always skipped would satisfy every case above and still be the bug.
   */
  it("sweeps once both halves are configured", async () => {
    const { fetcher, calls: requested } = countingFetcher();

    await runInventorySweep(
      envWithSweepCredentials(env, { accountId: "account", apiToken: "token" }),
      fetcher,
    );

    expect(requested.length).toBeGreaterThan(0);
    expect(requested[0]).toContain("/accounts/account/workers/durable_objects/namespaces");
  });
});
