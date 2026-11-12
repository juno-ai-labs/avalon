/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A D1 write a schema trigger refuses, on real D1: the logged code names the
 * trigger's reason, the way migration 0079's anchor fence refuses a delete
 * with `workspace_do_authoritative`, rather than reading as `d1_error`. A
 * trigger that raises a sentence is named as a trigger abort, and its
 * sentence is not copied.
 */

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { diagnosticErrorCode } from "../src/observability/logger";

async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("the trigger did not refuse the write");
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE fenced (id TEXT PRIMARY KEY)"),
    env.DB.prepare(`CREATE TRIGGER fenced_reject_delete BEFORE DELETE ON fenced
      BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END`),
    env.DB.prepare(`CREATE TRIGGER fenced_reject_update BEFORE UPDATE ON fenced
      BEGIN SELECT RAISE(ABORT, 'email routes are permanent tombstones'); END`),
    env.DB.prepare("INSERT INTO fenced VALUES ('a')"),
  ]);
});

describe("a write a D1 trigger refuses", () => {
  it("is logged by the reason the trigger raised, from a statement and from a batch", async () => {
    expect(diagnosticErrorCode(await refusal(() => env.DB.prepare("DELETE FROM fenced").run()), "internal_error"))
      .toBe("internal_error:sqlite_trigger_abort:workspace_do_authoritative");
    expect(diagnosticErrorCode(await refusal(() => env.DB.batch([env.DB.prepare("DELETE FROM fenced")])), "internal_error"))
      .toBe("internal_error:sqlite_trigger_abort:workspace_do_authoritative");
  });

  it("is named as a trigger abort without its sentence when the reason is prose", async () => {
    expect(diagnosticErrorCode(await refusal(() => env.DB.prepare("UPDATE fenced SET id = 'b'").run()), "internal_error"))
      .toBe("internal_error:sqlite_trigger_abort");
  });
});
