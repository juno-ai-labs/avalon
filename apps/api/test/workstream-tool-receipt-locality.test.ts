/**
 * A run reaches its own work stream's receipts without leaving the isolate.
 *
 * This is the Node suite because what is under test is a routing decision made
 * in plain JavaScript — is this port's work stream the one whose storage the
 * caller is holding — exactly as `durable-object-self-reference.test.ts` argues
 * for the resolver it backs up. What the storage then does is proved over the
 * real schema in `workstream-tool-receipt-storage.test.ts`, and what the object
 * does with a misrouted stub is proved on workerd in
 * `test-workers/tool-receipt-authority.test.ts`.
 *
 * The binding here throws on use rather than recording a call. A port that
 * still dispatches does not fail an expectation at the end of the test — it
 * fails at the moment it dispatches, naming the line, which is what makes the
 * absence of a round trip provable rather than inferred from a spy.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  objectOwnsWorkstreamAuthorities,
  withLocalWorkstreamAuthorities,
  type LocalAuthorityExecutor,
} from "../src/runtime/local-authorities";
import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import { WorkstreamToolReceiptStorage } from "../src/durable-objects/workstream-tool-receipt-storage";
import type { Env } from "../src/env";
import { createToolReceiptObjectPort } from "../src/runtime/tool-receipt-port";
import { asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const WORKSTREAM = "22222222-2222-4222-8222-222222222222";
const OTHER_WORKSTREAM = "33333333-3333-4333-8333-333333333333";
const THIRD_WORKSTREAM = "44444444-4444-4444-8444-444444444444";

/**
 * An installed authority, in the shape the owning object installs one.
 *
 * The registry holds *endpoints*, not tables — in the object the endpoint is
 * what refuses a fenced request and commits the projection — so this wraps the
 * real storage in the smallest thing with an endpoint's answer shape. What the
 * real endpoint adds on top is proved where it exists, on workerd, in
 * `test-workers/tool-receipt-authority.test.ts`.
 */
function residentReceipts(): LocalAuthorityExecutor {
  const receipts = storage();
  return async (operation, args) => {
    const method = receipts[operation as keyof WorkstreamToolReceiptStorage] as
      (...rest: unknown[]) => unknown;
    return { ok: true, value: method.apply(receipts, args) ?? null };
  };
}

/**
 * The real storage over `node:sqlite`, which is what the executor above reaches.
 *
 * No double: the storage runs here perfectly well, and a stand-in would prove
 * only that the port called something. The schema is applied and nothing is
 * seeded — every operation below is a read, and an empty answer from the real
 * tables is the proof that the read happened in this isolate.
 */
function storage(): WorkstreamToolReceiptStorage {
  const sql = createTestSqlStorage(new DatabaseSync(":memory:"));
  const binding = createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql,
  });
  applyWorkstreamObjectSchema(binding, "v", 1);
  return new WorkstreamToolReceiptStorage(binding);
}

/**
 * A namespace that cannot be used at all.
 *
 * `idFromName` is where `durableObjectStubForWorkspace` goes first for any name
 * that is not answered locally, so a throw here is the sound of the round trip
 * this change exists to remove.
 */
function unusableNamespace(): Env["SUBSTREAM_AGENTS"] {
  return createCloudflareTestBinding<Env["SUBSTREAM_AGENTS"]>({
    idFromName: () => {
      throw new Error("receipt operation left the isolate");
    },
    get: () => {
      throw new Error("receipt operation left the isolate");
    },
  });
}

function env(): Env {
  return createTestEnv({
    APP_ENV: "test",
    AVALON_REGION: "global",
    SUBSTREAM_AGENTS: unusableNamespace(),
  });
}

describe("a tool-receipt port built inside the object that owns the receipts", () => {
  it("answers out of the carried storage instead of dispatching", async () => {
    const carried = withLocalWorkstreamAuthorities(env(), WORKSPACE, WORKSTREAM, { toolReceipt: residentReceipts() });

    const port = createToolReceiptObjectPort(carried, WORKSPACE, WORKSTREAM);

    await expect(port.receiptsByIds({ effectIntentIds: ["effect-1"] })).resolves.toEqual([]);
  });

  it("still dispatches for a different work stream on the same environment", async () => {
    const carried = withLocalWorkstreamAuthorities(env(), WORKSPACE, WORKSTREAM, { toolReceipt: residentReceipts() });

    const port = createToolReceiptObjectPort(carried, WORKSPACE, OTHER_WORKSTREAM);

    // The sibling's receipts are not this object's to answer, so the round trip
    // is correct here and the unusable binding is what proves it was taken.
    await expect(port.receiptsByIds({ effectIntentIds: ["effect-1"] }))
      .rejects.toThrow("receipt operation left the isolate");
  });

  it("carries every registration made on an environment it was derived from", async () => {
    const first = withLocalWorkstreamAuthorities(
      env(),
      WORKSPACE,
      WORKSTREAM,
      { toolReceipt: residentReceipts() },
    );
    const second = withLocalWorkstreamAuthorities(
      first,
      WORKSPACE,
      OTHER_WORKSTREAM,
      { toolReceipt: residentReceipts() },
    );

    // A later registration must not shadow an earlier one. The object installs
    // one work stream's authorities per call, so an environment derived from
    // another carries both — and a registry that replaced rather than merged
    // would fail here rather than in whichever caller derived one first.
    await expect(createToolReceiptObjectPort(second, WORKSPACE, WORKSTREAM)
      .receiptsByIds({ effectIntentIds: [] })).resolves.toEqual([]);
    await expect(createToolReceiptObjectPort(second, WORKSPACE, OTHER_WORKSTREAM)
      .receiptsByIds({ effectIntentIds: [] })).resolves.toEqual([]);
    await expect(createToolReceiptObjectPort(second, WORKSPACE, THIRD_WORKSTREAM)
      .receiptsByIds({ effectIntentIds: [] })).rejects.toThrow("receipt operation left the isolate");
  });

  it("still takes an explicit override, for a work stream nothing registered", async () => {
    const port = createToolReceiptObjectPort(env(), WORKSPACE, WORKSTREAM, storage());

    await expect(port.receiptsByIds({ effectIntentIds: [] })).resolves.toEqual([]);
  });
});

/**
 * The ownership rule every installed authority rests on.
 *
 * It has to be the same rule the endpoints enforce on the wire —
 * `acceptToolReceiptOperation` and `runTerminalOperation` check the same three
 * things — because a local path answers where they would refuse. Each case
 * below is one clause of that guard.
 */
describe("the rule that decides whether this object owns a work stream's authorities", () => {
  const identity = {
    workspaceId: asWorkspaceId(WORKSPACE),
    workstreamId: asWorkstreamId(WORKSTREAM),
  };
  const target = { workspaceId: WORKSPACE, workstreamId: WORKSTREAM, substreamId: "0" };

  it("owns them when the identity matches and this is the main child", () => {
    expect(objectOwnsWorkstreamAuthorities(identity, "0", target)).toBe(true);
  });

  it("does not own them before the object has an identity", () => {
    expect(objectOwnsWorkstreamAuthorities(null, "0", target)).toBe(false);
  });

  it("does not own another work stream's, or another workspace's", () => {
    expect(objectOwnsWorkstreamAuthorities(identity, "0", { ...target, workstreamId: OTHER_WORKSTREAM }))
      .toBe(false);
    expect(objectOwnsWorkstreamAuthorities(identity, "0", { ...target, workspaceId: OTHER_WORKSTREAM }))
      .toBe(false);
  });

  it("does not own them when this object is not the main child", () => {
    expect(objectOwnsWorkstreamAuthorities(identity, "1", target)).toBe(false);
  });

  it("does not own them for a run dispatched to another substream", () => {
    expect(objectOwnsWorkstreamAuthorities(identity, "0", { ...target, substreamId: "1" })).toBe(false);
  });
});
