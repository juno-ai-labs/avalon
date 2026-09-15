import { describe, expect, it } from "vitest";
import { asSubstreamId } from "./identifiers";
import {
  agentAddressForId, agentIdForAddress, AgentIdSchema, StartAgentInputSchema,
  SendAgentMessageInputSchema, ReplyToAgentMessageInputSchema,
} from "./agent-communication";

const parentId = "00000000-0000-4000-8000-000000000001";
const otherParentId = "00000000-0000-4000-8000-000000000002";
const main = asSubstreamId("0");

describe("agent communication contracts", () => {
  it("addresses independent main conversations without allocating another identity", () => {
    const workstream = { parentKind: "workstream", parentId, substreamId: main } as const;
    const sidekick = { parentKind: "automation", parentId: otherParentId, substreamId: main } as const;
    expect(agentIdForAddress(workstream)).not.toBe(agentIdForAddress(sidekick));
    expect(agentAddressForId(agentIdForAddress(workstream))).toEqual(workstream);
    expect(agentAddressForId(agentIdForAddress(sidekick))).toEqual(sidekick);
    expect(AgentIdSchema.safeParse("0").success).toBe(false);
    expect(AgentIdSchema.safeParse(`${agentIdForAddress(sidekick)}/extra`).success).toBe(false);
  });

  it("requires explicit starting context and rejects undeclared model or authority overrides", () => {
    const input = { name: "Research", description: "Find primary sources", message: "Research the question." };
    expect(StartAgentInputSchema.parse(input).attachmentIds).toEqual([]);
    for (const key of ["model", "teamId", "permissions", "copyHistory"]) {
      expect(StartAgentInputSchema.safeParse({ ...input, [key]: "override" }).success).toBe(false);
    }
    expect(StartAgentInputSchema.safeParse({ name: input.name, message: input.message }).success).toBe(false);
  });

  it("supports existing attachments on start, send and reply while retaining distinct addressing", () => {
    const content = { message: "", attachmentIds: [parentId] };
    expect(StartAgentInputSchema.parse({ name: "Image", description: "Inspect image", ...content })).toMatchObject(content);
    const agentId = agentIdForAddress({ parentKind: "workstream", parentId, substreamId: main });
    expect(SendAgentMessageInputSchema.parse({ agentId, ...content })).toMatchObject(content);
    expect(ReplyToAgentMessageInputSchema.parse({ messageId: otherParentId, ...content })).toMatchObject(content);
    expect(SendAgentMessageInputSchema.safeParse({ agentId, message: " " }).success).toBe(false);
    expect(ReplyToAgentMessageInputSchema.safeParse({ agentId, messageId: otherParentId, ...content }).success).toBe(false);
    expect(SendAgentMessageInputSchema.safeParse({ agentId, messageId: otherParentId, ...content }).success).toBe(false);
  });
});
