import { afterEach, describe, expect, it } from "vitest";
import { asUserId, asWorkspaceId, SidekickExecutionDelegationSchema } from "@rally/contracts";
import { ConnectorError, connectorResourceAccessRefused } from "@rally/connectors";
import type { HarnessToolContext } from "@rally/agent-harness";
import type { DatabaseSync } from "node:sqlite";
import { executeSidekickAccountOperation, type SidekickAccountConnection } from "../src/services/sidekick-operation-accounts";
import {
  seedToolReceipt, seedWorkstreamRun, seedWorkstreamObjectRoot, testToolReceiptPort, testWorkstreamObjectStore,
} from "./helpers/durable-authority";

const id = (n: number) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const workspaceId = asWorkspaceId(id(1)), creator = asUserId(id(2)), other = asUserId(id(3));
const authority = () => SidekickExecutionDelegationSchema.parse({
  sidekickId: id(4), creatorUserId: creator, accountUserId: creator,
  delegates: [{ userId: creator, generation: 7, grantedAt: 1 }, { userId: other, generation: 9, grantedAt: 2 }],
});
const a: SidekickAccountConnection = { connectionId: id(5), scope: "personal", ownerUserId: creator, modelPluginId: "plugin_adam" };
const b: SidekickAccountConnection = { connectionId: id(6), scope: "personal", ownerUserId: other, modelPluginId: "plugin_maya" };
const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture() {
  const database = testWorkstreamObjectStore();
  databases.push(database);
  seedWorkstreamObjectRoot(database, { workstreamId: id(8), workspaceId });
  seedWorkstreamRun(database, { id: id(7), attemptId: "attempt", leaseOwner: "owner", leaseExpiresAt: Date.now() + 600_000 });
  const fence = { runId: id(7), attemptId: "attempt", owner: "owner" };
  const receipts = testToolReceiptPort(database);
  let sequence = 0;
  const context = (mode: "read" | "write" = "read"): HarnessToolContext => {
    sequence++;
    seedToolReceipt(database, { id: `effect-${sequence}`, runId: id(7), toolCallId: `call-${sequence}`, toolName: "test",
      position: sequence, status: "executing", mode, executionPlanJson: JSON.stringify({ mode }) });
    return { workspaceId, workstreamId: id(8), harnessRunId: id(7), toolCallId: `call-${sequence}`, effectIntentId: `effect-${sequence}`,
      executionPrincipal: { type: "user", userId: creator }, signal: new AbortController().signal };
  };
  const complete = async (call: HarnessToolContext) => {
    await receipts.complete({ effectIntentId: call.effectIntentId!, checkpointIndex: 100, outputRef: "result", outputSummary: "done",
      providerOperationId: null, payloadJson: "{}", allowAmbiguousReconciliation: false, fence, now: Date.now() });
  };
  const calls: string[] = [];
  const options = (call = context()) => ({
    authority: authority(), workspaceId, coordinatorUserId: creator, requested: a, candidates: [b, a, b],
    sourceConnectionIds: [] as string[],
    canFallback: true, context: call, receipts, fence,
    execute: async (connection: SidekickAccountConnection) => {
      calls.push(connection.connectionId);
      return { output: { values: [["Read"]] }, summary: "Read sheet" };
    },
  });
  return { database, receipts, context, complete, calls, options };
}

describe("Sidekick operation account selection over durable receipts", () => {
  it("selects independently for a new operation after a read through another delegate", async () => {
    const f = fixture(), read = f.context();
    await executeSidekickAccountOperation({ ...f.options(read), requested: b });
    await f.complete(read);
    await executeSidekickAccountOperation(f.options(f.context("write")));
    expect(f.calls).toEqual([id(6), id(5)]);
  });

  it("tries the creator before other delegates, deduplicates connections and records actual fallback", async () => {
    const f = fixture(), call = f.context();
    const output = await executeSidekickAccountOperation({ ...f.options(call), execute: async (connection) => {
      f.calls.push(connection.connectionId);
      if (connection.connectionId === a.connectionId) throw connectorResourceAccessRefused("Not shared", {});
      return { output: { values: [["Calendar"]] }, summary: "Read calendar" };
    } });
    expect(f.calls).toEqual([id(5), id(6)]);
    expect(output.output).toEqual({ values: [["Calendar"]] });
    expect(await f.receipts.executionAccount({ runId: id(7), effectIntentId: call.effectIntentId! })).toMatchObject({
      phase: "served", originalAccount: { connectionId: id(5), grantGeneration: 7 }, account: { connectionId: id(6), grantGeneration: 9 },
    });
  });

  it("starts with the selected plugin without a provider access probe", async () => {
    const f = fixture();
    await executeSidekickAccountOperation({ ...f.options(), requested: b });
    expect(f.calls).toEqual([id(6)]);
  });

  it.each([new ConnectorError("provider_error", "Temporary failure"), new DOMException("Timed out", "TimeoutError"),
    new DOMException("Cancelled", "AbortError")])("does not switch account after an uncertain failure: %s", async (error) => {
    const f = fixture(), call = f.context("write");
    await expect(executeSidekickAccountOperation({ ...f.options(call), execute: async (connection) => {
      f.calls.push(connection.connectionId);
      if (connection.connectionId === a.connectionId) throw error;
      return { output: { unexpectedAccountSwitch: true }, summary: "Wrong account" };
    } })).rejects.toBe(error);
    expect(f.calls).toEqual([id(5)]);
    expect(await f.receipts.executionAccount({ runId: id(7), effectIntentId: call.effectIntentId! })).toMatchObject({ phase: "selected" });
    await executeSidekickAccountOperation({ ...f.options(call), sourceConnectionIds: [b.connectionId] });
    expect(f.calls).toEqual([id(5), id(5)]);
  });

  it("allows a write to fall back only after a declared pre-effect refusal", async () => {
    const f = fixture();
    await executeSidekickAccountOperation({ ...f.options(f.context("write")), execute: async (connection) => {
      f.calls.push(connection.connectionId);
      if (connection.connectionId === a.connectionId) throw connectorResourceAccessRefused("Not writable", {});
      return { output: { updatedCells: 1 }, summary: "Updated sheet" };
    } });
    expect(f.calls).toEqual([id(5), id(6)]);
  });

  it("records an Organization connection with its workspace principal", async () => {
    const f = fixture();
    const organization: SidekickAccountConnection = { connectionId: id(9), scope: "workspace", ownerUserId: null, modelPluginId: "plugin_org" };
    const result = await executeSidekickAccountOperation({ ...f.options(), requested: organization,
      candidates: [],
    });
    expect(f.calls).toEqual([id(9)]);
    expect(await f.receipts.executionAccount({ runId: id(7), effectIntentId: "effect-1" }))
      .toMatchObject({ account: { principal: { type: "workspace", workspaceId: id(1) } } });
    expect(result.output).toEqual({ values: [["Read"]] });
  });

  it("keeps an uncertain Organization write with its original delegate across withdrawal and regrant", async () => {
    const f = fixture(), call = f.context("write");
    const organization: SidekickAccountConnection = { connectionId: id(9), scope: "workspace", ownerUserId: null, modelPluginId: "plugin_org" };
    const options = { ...f.options(call), requested: organization,
      candidates: [] };
    await expect(executeSidekickAccountOperation({ ...options, execute: async () => {
      throw new TypeError("Response lost");
    } })).rejects.toThrow("Response lost");
    const withdrawn = authority();
    withdrawn.delegates = withdrawn.delegates.filter((grant) => grant.userId !== creator);
    await expect(executeSidekickAccountOperation({ ...options, authority: withdrawn, coordinatorUserId: other }))
      .rejects.toThrow("originating delegate is unavailable");
    expect(f.calls).toEqual([]);
    const regranted = authority();
    regranted.delegates[0]!.generation = 11;
    await executeSidekickAccountOperation({ ...options, authority: regranted, coordinatorUserId: other });
    expect(await f.receipts.executionAccount({ runId: call.harnessRunId, effectIntentId: call.effectIntentId! }))
      .toMatchObject({ originalAccount: { delegatedUserId: creator, grantGeneration: 7 },
        account: { delegatedUserId: creator, grantGeneration: 11 } });
  });
});
