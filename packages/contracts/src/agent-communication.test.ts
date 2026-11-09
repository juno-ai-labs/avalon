import { describe, expect, it } from "vitest";
import { asSubstreamId } from "./identifiers";
import {
  agentAddressForId, agentIdForAddress, AgentIdSchema, AgentMessageResultSchema, StartAgentInputSchema,
  StartAgentResultSchema, SendAgentMessageInputSchema, ReplyToAgentMessageInputSchema, StopAgentInputSchema,
  modelAgentId,
} from "./agent-communication";

const parentId = "00000000-0000-4000-8000-000000000001";
const otherParentId = "00000000-0000-4000-8000-000000000002";
const main = asSubstreamId("0");

describe("agent communication contracts", () => {
  it("addresses independent main conversations without allocating another identity", () => {
    const canvas = { parentKind: "canvas", parentId, substreamId: main } as const;
    const sidekick = { parentKind: "automation", parentId: otherParentId, substreamId: main } as const;
    expect(agentIdForAddress(canvas)).not.toBe(agentIdForAddress(sidekick));
    expect(agentAddressForId(agentIdForAddress(canvas))).toEqual(canvas);
    // A Thread agent id is no longer an address: Threads retired.
    expect(AgentIdSchema.safeParse(`workstream/${parentId}/0`).success).toBe(false);
    expect(agentAddressForId(agentIdForAddress(sidekick))).toEqual(sidekick);
    expect(AgentIdSchema.safeParse("0").success).toBe(false);
    expect(AgentIdSchema.safeParse(`${agentIdForAddress(sidekick)}/extra`).success).toBe(false);
  });

  it("shows a model a Sidekick's agent id as sidekick/… and takes either spelling back", () => {
    const stored = agentIdForAddress({ parentKind: "automation", parentId: otherParentId, substreamId: main });
    const canvas = agentIdForAddress({ parentKind: "canvas", parentId, substreamId: main });
    expect(modelAgentId(stored)).toBe(`sidekick/${otherParentId}/0`);
    expect(modelAgentId(canvas)).toBe(`canvas/${parentId}/0`);
    expect(SendAgentMessageInputSchema.parse({ agentId: `sidekick/${otherParentId}/0`, message: "Hi" }).agentId).toBe(stored);
    expect(SendAgentMessageInputSchema.parse({ agentId: stored, message: "Hi" }).agentId).toBe(stored);
    expect(StopAgentInputSchema.parse({ agentId: `sidekick/${otherParentId}/0` }).agentId).toBe(stored);
    expect(SendAgentMessageInputSchema.safeParse({ agentId: `sidekick/${otherParentId}`, message: "Hi" }).success).toBe(false);
  });

  it("requires explicit starting context and rejects undeclared model or authority overrides", () => {
    const input = { name: "Research", description: "Find primary sources", message: "Research the question." };
    expect(StartAgentInputSchema.parse(input).attachmentIds).toEqual([]);
    for (const key of ["model", "teamId", "permissions", "copyHistory"]) {
      expect(StartAgentInputSchema.safeParse({ ...input, [key]: "override" }).success).toBe(false);
    }
    expect(StartAgentInputSchema.safeParse({ name: input.name, message: input.message }).success).toBe(false);
  });

  it("rejects host account references supplied through model message tools", () => {
    const agentId = agentIdForAddress({ parentKind: "automation", parentId, substreamId: main });
    const sidekickAccountReferences = [{ sidekickId: parentId, connectionId: otherParentId, resourceKeys: ["google:message:mail"] }];
    expect(StartAgentInputSchema.safeParse({ name: "Reply", description: "Reply to mail", message: "Reply.", sidekickAccountReferences }).success).toBe(false);
    expect(SendAgentMessageInputSchema.safeParse({ agentId, message: "Reply.", sidekickAccountReferences }).success).toBe(false);
    expect(ReplyToAgentMessageInputSchema.safeParse({ messageId: otherParentId, message: "Reply.", sidekickAccountReferences }).success).toBe(false);
  });

  it("supports existing attachments on start, send and reply while retaining distinct addressing", () => {
    const content = { message: "", attachmentIds: [parentId] };
    expect(StartAgentInputSchema.parse({ name: "Image", description: "Inspect image", ...content })).toMatchObject(content);
    const agentId = agentIdForAddress({ parentKind: "canvas", parentId, substreamId: main });
    expect(SendAgentMessageInputSchema.parse({ agentId, ...content })).toMatchObject(content);
    expect(ReplyToAgentMessageInputSchema.parse({ messageId: otherParentId, ...content })).toMatchObject(content);
    expect(SendAgentMessageInputSchema.safeParse({ agentId, message: " " }).success).toBe(false);
    expect(ReplyToAgentMessageInputSchema.safeParse({ agentId, messageId: otherParentId, ...content }).success).toBe(false);
    expect(SendAgentMessageInputSchema.safeParse({ agentId, messageId: otherParentId, ...content }).success).toBe(false);
  });

  it("returns the delivery sentence with every started agent and accepted message", () => {
    const agentId = agentIdForAddress({ parentKind: "canvas", parentId, substreamId: main });
    const next = "Its reply will arrive here as a message.";
    expect(StartAgentResultSchema.parse({ agentId, name: "Research", next })).toEqual({ agentId, name: "Research", next });
    expect(StartAgentResultSchema.safeParse({ agentId }).success).toBe(false);
    expect(StartAgentResultSchema.safeParse({ agentId, name: "Research", next, status: "executing" }).success).toBe(false);
    expect(AgentMessageResultSchema.parse({ messageId: otherParentId, next })).toEqual({ messageId: otherParentId, next });
    expect(AgentMessageResultSchema.safeParse({ messageId: otherParentId }).success).toBe(false);
  });
});
