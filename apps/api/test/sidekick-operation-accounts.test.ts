import { afterEach, describe, expect, it } from "vitest";
import { asUserId, asWorkspaceId, SidekickExecutionDelegationSchema } from "@rally/contracts";
import { ConnectorError, connectorResourceAccessRefused } from "@rally/connectors";
import { validateToolArguments, type HarnessToolContext } from "@rally/agent-harness";
import type { DatabaseSync } from "node:sqlite";
import { executeSidekickAccountOperation, sidekickAccountToolDefinition, splitSidekickAccount, type SidekickAccountConnection } from "../src/services/sidekick-operation-accounts";
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
    authority: authority(), workspaceId, coordinatorUserId: creator, requested: b, candidates: [b, a, b],
    sourceConnectionIds: [] as string[], identity: { kind: "resource" as const, resourceKeys: ["google:file:sheet"] },
    mode: "read" as "read" | "write", canFallback: true, context: call, receipts, fence,
    execute: async (connection: SidekickAccountConnection) => {
      calls.push(connection.connectionId);
      return { output: { values: [["Read"]] }, summary: "Read sheet" };
    },
  });
  return { database, receipts, context, complete, calls, options };
}

describe("Sidekick operation account selection over durable receipts", () => {
  it("keeps activation mail IDs with their source account without redirecting a new inbox search", async () => {
    const f = fixture();
    const sourceAccount = { connectionId: b.connectionId, resourceKeys: ["google:message:event-message"] };
    const result = await executeSidekickAccountOperation({ ...f.options(), sourceAccount,
      identity: { kind: "account", resourceKeys: ["google:message:event-message"] } });
    expect(result.executionAccount.connectionId).toBe(id(6));
    await executeSidekickAccountOperation({ ...f.options(), sourceAccount,
      identity: { kind: "account", resourceKeys: [] } });
    expect(f.calls).toEqual([id(6), id(5)]);
    await expect(executeSidekickAccountOperation({ ...f.options(), sourceAccount, selection: { userId: creator },
      identity: { kind: "account", resourceKeys: ["google:message:event-message"] } })).rejects.toThrow("originating Sidekick account is unavailable");
    const withdrawn = authority();
    withdrawn.delegates = withdrawn.delegates.filter((grant) => grant.userId !== other);
    await expect(executeSidekickAccountOperation({ ...f.options(), authority: withdrawn, sourceAccount,
      identity: { kind: "account", resourceKeys: ["google:message:event-message"] } })).rejects.toThrow("originating Sidekick account is unavailable");
    expect(f.calls).toEqual([id(6), id(5)]);
  });

  it("prefers a canonical source for a portable file while retaining safe read fallback", async () => {
    const f = fixture();
    await executeSidekickAccountOperation({ ...f.options(), sourceAccount: { connectionId: b.connectionId, resourceKeys: ["google:file:sheet"] },
      execute: async (connection) => {
        f.calls.push(connection.connectionId);
        if (connection.connectionId === b.connectionId) throw connectorResourceAccessRefused("Not shared", {});
        return { output: { values: [["Read"]] }, summary: "Read sheet" };
      } });
    expect(f.calls).toEqual([id(6), id(5)]);
  });
  it("accepts a nullable unused selector without forwarding host account fields to the provider", () => {
    const definition = sidekickAccountToolDefinition({ name: "search", capability: "test.read", mode: "read", idempotency: "safe",
      description: "Search", inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" } } } });
    const selected = { query: "subject:standup", rallyAccount: { userId: other, connectionId: null } };
    expect(validateToolArguments(selected, definition.inputSchema)).toBeNull();
    expect(splitSidekickAccount(selected)).toEqual({ input: { query: "subject:standup" }, selection: { userId: id(3) } });
    expect(validateToolArguments({ query: "subject:standup", rallyAccount: null }, definition.inputSchema)).toBeNull();
    expect(splitSidekickAccount({ query: "subject:standup", rallyAccount: null })).toEqual({ input: { query: "subject:standup" } });
    const invalid = { rallyAccount: { userId: null, connectionId: null } };
    expect(validateToolArguments(invalid, definition.inputSchema)).not.toBeNull();
    expect(() => splitSidekickAccount(invalid)).toThrow("rallyAccount");
  });

  it("tries the creator before other delegates, deduplicates connections and records actual fallback", async () => {
    const f = fixture(), call = f.context();
    const output = await executeSidekickAccountOperation({ ...f.options(call), execute: async (connection) => {
      f.calls.push(connection.connectionId);
      if (connection.connectionId === a.connectionId) throw connectorResourceAccessRefused("Not shared", {});
      return { output: { values: [["Calendar"]] }, summary: "Read calendar" };
    } });
    expect(f.calls).toEqual([id(5), id(6)]);
    expect(output.output).toMatchObject({ values: [["Calendar"]], servedThrough: { userId: id(3), connectionId: id(6) } });
    expect(await f.receipts.executionAccount({ runId: id(7), effectIntentId: call.effectIntentId! })).toMatchObject({
      phase: "served", originalAccount: { connectionId: id(5), grantGeneration: 7 }, account: { connectionId: id(6), grantGeneration: 9 },
    });
  });

  it("prefers a configured source account without a provider access probe", async () => {
    const f = fixture();
    await executeSidekickAccountOperation({ ...f.options(), sourceConnectionIds: [b.connectionId] });
    expect(f.calls).toEqual([id(6)]);
  });

  it("keeps a planned write with the account that read the resource and refuses after its withdrawal", async () => {
    const f = fixture(), read = f.context();
    await executeSidekickAccountOperation({ ...f.options(read), sourceConnectionIds: [b.connectionId] });
    await f.complete(read);
    await executeSidekickAccountOperation({ ...f.options(f.context("write")), requested: a, mode: "write" });
    expect(f.calls).toEqual([id(6), id(6)]);
    await expect(executeSidekickAccountOperation({ ...f.options(f.context("write")), mode: "write",
      authority: { ...authority(), delegates: authority().delegates.filter((grant) => grant.userId !== other) },
    })).rejects.toThrow("originating Sidekick account is unavailable");
    expect(f.calls).toEqual([id(6), id(6)]);
  });

  it("uses the task account for an unqualified empty search without searching other delegates", async () => {
    const f = fixture();
    const result = await executeSidekickAccountOperation({ ...f.options(), identity: { kind: "account", resourceKeys: [] },
      execute: async (connection) => { f.calls.push(connection.connectionId); return { output: { messages: [] }, summary: "No matches" }; },
    });
    expect(f.calls).toEqual([id(5)]);
    expect(result.output).toMatchObject({ messages: [], servedThrough: { userId: id(2) } });
  });

  it("keeps named-account messages and replies with their originating account", async () => {
    const f = fixture(), read = f.context();
    await executeSidekickAccountOperation({ ...f.options(read), identity: { kind: "account", resourceKeys: [] },
      selection: { userId: other }, resultKeys: () => ["google:message:mail-1"],
    });
    await f.complete(read);
    await executeSidekickAccountOperation({ ...f.options(f.context("write")), requested: a, mode: "write",
      identity: { kind: "account", resourceKeys: ["google:message:mail-1"] },
    });
    expect(f.calls).toEqual([id(6), id(6)]);
    await expect(executeSidekickAccountOperation({ ...f.options(f.context("write")), mode: "write",
      identity: { kind: "account", resourceKeys: ["google:message:mail-1"] }, selection: { userId: creator },
    })).rejects.toThrow("depends on another account's result");
    expect(f.calls).toEqual([id(6), id(6)]);
  });

  it("pins issued continuations even when the task default and source order differ", async () => {
    const f = fixture(), call = f.context();
    call.executionAccount = { sidekickId: id(4), connectionId: id(6), delegatedUserId: other,
      grantGeneration: 9, principal: { type: "user", userId: other } };
    await executeSidekickAccountOperation({ ...f.options(call), requested: a, identity: { kind: "account", resourceKeys: [] } });
    expect(f.calls).toEqual([id(6)]);
  });

  it("requires an account for an ambiguous reference while a saved continuation retains its account", async () => {
    const f = fixture(), first = f.context(), second = f.context();
    const reference = "google:mail_query:subject:standup";
    await executeSidekickAccountOperation({ ...f.options(first), identity: { kind: "account", resourceKeys: [] },
      selection: { userId: other }, resultKeys: () => [reference] });
    await f.complete(first);
    await executeSidekickAccountOperation({ ...f.options(second), identity: { kind: "account", resourceKeys: [] },
      resultKeys: () => [reference] });
    await f.complete(second);
    await expect(executeSidekickAccountOperation({ ...f.options(f.context("write")), mode: "write",
      identity: { kind: "account", resourceKeys: [reference] } })).rejects.toThrow("more than one account");
    const page = f.context();
    page.executionAccount = { sidekickId: id(4), connectionId: id(6), delegatedUserId: other, grantGeneration: 9,
      principal: { type: "user", userId: other } };
    await executeSidekickAccountOperation({ ...f.options(page), identity: { kind: "account", resourceKeys: [reference] } });
    await executeSidekickAccountOperation({ ...f.options(f.context("write")), mode: "write",
      identity: { kind: "account", resourceKeys: [reference] }, selection: { userId: other } });
    expect(f.calls).toEqual([id(6), id(5), id(6), id(6)]);
  });

  it.each([new ConnectorError("provider_error", "Temporary failure"), new DOMException("Timed out", "TimeoutError"),
    new DOMException("Cancelled", "AbortError")])("does not switch account after an uncertain failure: %s", async (error) => {
    const f = fixture(), call = f.context("write");
    await expect(executeSidekickAccountOperation({ ...f.options(call), mode: "write", execute: async (connection) => {
      f.calls.push(connection.connectionId);
      if (connection.connectionId === a.connectionId) throw error;
      return { output: { unexpectedAccountSwitch: true }, summary: "Wrong account" };
    } })).rejects.toBe(error);
    expect(f.calls).toEqual([id(5)]);
    expect(await f.receipts.executionAccount({ runId: id(7), effectIntentId: call.effectIntentId! })).toMatchObject({ phase: "selected" });
    await executeSidekickAccountOperation({ ...f.options(call), sourceConnectionIds: [b.connectionId], mode: "write" });
    expect(f.calls).toEqual([id(5), id(5)]);
  });

  it("allows a write to fall back only after a declared pre-effect refusal", async () => {
    const f = fixture();
    await executeSidekickAccountOperation({ ...f.options(f.context("write")), mode: "write", execute: async (connection) => {
      f.calls.push(connection.connectionId);
      if (connection.connectionId === a.connectionId) throw connectorResourceAccessRefused("Not writable", {});
      return { output: { updatedCells: 1 }, summary: "Updated sheet" };
    } });
    expect(f.calls).toEqual([id(5), id(6)]);
  });

  it("restricts an explicit account instead of falling through to a different person", async () => {
    const f = fixture();
    await expect(executeSidekickAccountOperation({ ...f.options(), selection: { userId: creator }, execute: async (connection) => {
      f.calls.push(connection.connectionId); throw connectorResourceAccessRefused("Not shared", {});
    } })).rejects.toThrow("Not shared");
    expect(f.calls).toEqual([id(5)]);
  });

  it("records an explicitly selected Organization connection with its workspace principal", async () => {
    const f = fixture();
    const organization: SidekickAccountConnection = { connectionId: id(9), scope: "workspace", ownerUserId: null, modelPluginId: "plugin_org" };
    const result = await executeSidekickAccountOperation({ ...f.options(), requested: organization,
      selection: { connectionId: id(9) }, identity: { kind: "account", resourceKeys: [] },
    });
    expect(f.calls).toEqual([id(9)]);
    expect(result.executionAccount.principal).toEqual({ type: "workspace", workspaceId: id(1) });
    expect(result.output).toMatchObject({ servedThrough: { scope: "workspace", userId: null } });
  });
});
