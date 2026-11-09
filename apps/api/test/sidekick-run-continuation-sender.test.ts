import { describe, expect, it } from "vitest";

import { agentIdForAddress, asSubstreamId } from "@rally/contracts";

import { continuationSender } from "../src/services/sidekick-run-continuation";

const SIDEKICK_ID = "00000000-0000-7000-8000-00000000d100";
const READER_ID = "00000000-0000-7000-8000-00000000d101";
const OTHER_AGENT = agentIdForAddress({ parentKind: "canvas", parentId: "00000000-0000-7000-8000-00000000d102", substreamId: asSubstreamId("0") });
const WIZARD = agentIdForAddress({ parentKind: "automation", parentId: SIDEKICK_ID, substreamId: asSubstreamId("0") });
const SYSTEM = { actor: "system", author_user_id: null } as const;

describe("who sent a Sidekick run's input", () => {
  it("names a person's own message", () => {
    expect(continuationSender({ actor: "human", author_user_id: READER_ID }, {}))
      .toEqual({ kind: "person", userId: READER_ID });
  });

  it("names the person another agent acts for, preferring the sender's principal over a worker's own", () => {
    expect(continuationSender(SYSTEM, {
      agentExchange: { senderAgentId: OTHER_AGENT },
      executionPrincipal: { type: "user", userId: "00000000-0000-7000-8000-00000000d103" },
      senderExecutionPrincipal: { type: "user", userId: READER_ID },
    })).toEqual({ kind: "person", userId: READER_ID });
  });

  it("names whoever drove the Sidekick's own wizard turn, the wizard being no exception", () => {
    expect(continuationSender(SYSTEM, {
      agentExchange: { senderAgentId: WIZARD }, senderExecutionPrincipal: { type: "user", userId: READER_ID },
    })).toEqual({ kind: "person", userId: READER_ID });
  });

  it("marks an agent acting for no person as unattributed", () => {
    const workspace = { type: "workspace", workspaceId: "00000000-0000-7000-8000-00000000d104" };
    expect(continuationSender(SYSTEM, { agentExchange: { senderAgentId: OTHER_AGENT }, senderExecutionPrincipal: workspace }))
      .toEqual({ kind: "unattributed" });
  });

  it("reads a reply in a bound provider thread as outside text, whoever its provider identity resolved to", () => {
    expect(continuationSender({ actor: "external", author_user_id: null }, { slackOrigin: { matchedAvalonUserId: READER_ID } }))
      .toEqual({ kind: "external" });
    expect(continuationSender({ actor: "external", author_user_id: null }, { slackOrigin: null }))
      .toEqual({ kind: "external" });
  });

  it("reads a scheduled wake-up or a review notice as Rally's own", () => {
    expect(continuationSender(SYSTEM, { executionPrincipal: { type: "user", userId: READER_ID } }))
      .toEqual({ kind: "system" });
  });
});
