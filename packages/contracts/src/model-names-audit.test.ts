import { describe, expect, it } from "vitest";

import { auditToolsInPlace, auditedTools, failureAsModelReads, storageNamesIn, StorageNameLeakError } from "./model-names-audit";

const found = (value: unknown, options?: Parameters<typeof storageNamesIn>[1]) =>
  storageNamesIn(value, options).map(({ path, where, word }) => `${path} ${where} ${word}`);

describe("the storage-name audit", () => {
  it("finds a storage name in a key, an enum value, an id and a sentence, at any depth", () => {
    expect(found({
      workstreamId: "0190a000",
      items: [{ parentKind: "automation", provider: "avalon_upload", loopId: "workstream:1:substream:0:loop" }],
      note: "Filed in this workspace by an automation.",
    })).toEqual([
      "$.workstreamId key workstream",
      "$.items[0].parentKind value automation",
      "$.items[0].provider value avalon",
      "$.items[0].loopId value workstream",
      "$.items[0].loopId value substream",
      "$.note value workspace",
      "$.note value automation",
    ]);
  });

  it("reads every spelling of a key: camel case, snake case, plural, and two words", () => {
    expect(found({ workspace_id: 1, WorkStream: 1, substreams: 1, workspaceid: 1, "work stream": 1 })).toEqual([
      "$.workspace_id key workspace",
      "$.WorkStream key workstream",
      "$.substreams key substream",
      "$.workspaceid key workspace",
      "$.work stream key workstream",
    ]);
  });

  it("finds a retired product word in a key and in prose a tool authored", () => {
    expect(found({ channelId: "c1", breakout: null, error: "This thread already has 20 pending wake-ups." })).toEqual([
      "$.channelId key channel",
      "$.breakout key breakout",
      "$.error value thread",
    ]);
  });

  it("finds nothing in product words, or in a word that only contains one", () => {
    expect(found({
      canvasId: "0190a000", sidekickId: "0190a001", organizationId: "0190a002", scope: "organization",
      provider: "rally_upload", namespace: "page", projection: "threaded", agentId: "sidekick/0190a001/0",
      next: "Its reply will arrive in this conversation.",
    })).toEqual([]);
  });

  it("leaves the two honest meanings of workspace, and the two identifiers Rally keeps", () => {
    expect(found({
      cwd: "/workspace/out", error: "Choose a path under the workspace root of the terminal workspace.",
      account: "Reconnect the Slack workspace. An uploaded PDF is not a Workspace document.",
      hint: "Write beneath $AVALON_RESOURCE_DIR (/workspace/.rally-output).", headRef: "avalon/quiet-amber-river-stone",
    })).toEqual([]);
  });

  it("lets a person's or a provider's prose say a retired word, and nothing else", () => {
    const fixture = { title: "Notes from the project channel", channel: "C123", kind: "thread", body: "Moved to another workspace." };
    expect(found(fixture, { dataProse: true })).toEqual([
      "$.channel key channel",
      "$.kind value thread",
      "$.body value workspace",
    ]);
    // A provider whose own vocabulary has the word names it.
    expect(found(fixture, { dataProse: true, allowWords: ["channel", "thread"] })).toEqual(["$.body value workspace"]);
    expect(found(fixture, { dataProse: true, allowWords: ["channel", "thread"], allow: [/another workspace/gu] })).toEqual([]);
  });

  it("reads a thrown failure as the model does: the code translated, the details kept", () => {
    const failure = Object.assign(new Error("workstream_archived"), {
      code: "workstream_archived", details: { reason: "Reopen the Canvas first." },
    });
    expect(failureAsModelReads(failure)).toEqual({
      error: "canvas_archived", data: { code: "canvas_archived", details: { reason: "Reopen the Canvas first." } },
    });
    expect(found(failureAsModelReads(failure))).toEqual([]);
  });

  const tool = (execute: () => Promise<{ output: unknown; summary: string }>) => ({ definition: { name: "list_things" }, execute });

  it("passes a clean result through, and fails a call whose result names storage", async () => {
    const [clean] = auditedTools([tool(async () => ({ output: { canvasId: "c1" }, summary: "Listed the work-stream" }))]);
    // `summary` goes to the person watching, never to the model, so it is not walked.
    await expect(clean!.execute()).resolves.toEqual({ output: { canvasId: "c1" }, summary: "Listed the work-stream" });

    const [leaking] = auditedTools([tool(async () => ({ output: { workstreamId: "c1" }, summary: "Listed" }))]);
    await expect(leaking!.execute()).rejects.toThrow(StorageNameLeakError);
    await expect(leaking!.execute()).rejects.toThrow(
      'list_things hands the model a storage name:\n$.output.workstreamId: key says "workstream" (workstreamId)',
    );
  });

  it("rethrows a tool's own failure unchanged, and fails one that names storage in a sentence", async () => {
    const refusal = Object.assign(new Error("This Canvas is archived."), { code: "workstream_archived" });
    const [refusing] = auditedTools([tool(async () => { throw refusal; })]);
    await expect(refusing!.execute()).rejects.toBe(refusal);

    const [leaking] = auditedTools([tool(async () => { throw new Error("This work stream is archived."); })]);
    await expect(leaking!.execute()).rejects.toThrow('$.error: value says "workstream" (This work stream is archived.)');
  });

  it("audits a tool in place, so it stays the object its host knows it by", async () => {
    const built = tool(async () => ({ output: { parentKind: "automation" }, summary: "Read" }));
    auditToolsInPlace([built]);
    await expect(built.execute()).rejects.toThrow('$.output.parentKind: value says "automation" (automation)');
  });
});
