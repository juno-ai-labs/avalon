/**
 * Which conversation's sandbox a run uses.
 *
 * A routing decision in plain JavaScript over one ownership read, so the Node
 * suite: the read is a table here, and what the real `agent_delegations` table
 * answers is proved on workerd in `test-workers/agent-teams.test.ts`.
 */
import { agentIdForAddress, asSubstreamId, asWorkspaceId, type AgentId } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import { resolveTerminalRunScope } from "../src/services/terminal/authority";

const WORKSPACE = asWorkspaceId("11111111-1111-4111-8111-111111111111");
const WORKSTREAM = "22222222-2222-4222-8222-222222222222";
const OTHER_WORKSTREAM = "33333333-3333-4333-8333-333333333333";
const THREAD = "44444444-4444-4444-8444-444444444444";
const WORKER = "55555555-5555-4555-8555-555555555555";
const NESTED_WORKER = "66666666-6666-4666-8666-666666666666";

function agent(parentId: string, substreamId: string): AgentId {
  return agentIdForAddress({ parentKind: "canvas", parentId, substreamId: asSubstreamId(substreamId) });
}

/** The ownership table, as `agentOwner` reads it: child to owner. */
function owners(edges: Array<[child: AgentId, owner: AgentId]>) {
  const table = new Map(edges);
  return vi.fn(async (agentId: AgentId) => table.get(agentId) ?? null);
}

function input(substreamId: string | undefined, backgroundAgent: boolean) {
  return {
    workspaceId: WORKSPACE,
    parentKind: "canvas" as const,
    parentId: WORKSTREAM,
    ...(substreamId === undefined ? {} : { substreamId: asSubstreamId(substreamId) }),
    backgroundAgent,
  };
}

describe("the conversation whose Terminal a run uses", () => {
  it("is the run's own conversation, read from nothing, when the run is not a background agent", async () => {
    const ownerOf = owners([[agent(WORKSTREAM, THREAD), agent(WORKSTREAM, "0")]]);

    await expect(resolveTerminalRunScope(input(undefined, false), ownerOf))
      .resolves.toEqual({ parentKind: "canvas", backgroundAgent: false, runSubstreamId: "0", authoritySubstreamId: "0" });
    await expect(resolveTerminalRunScope(input(THREAD, false), ownerOf))
      .resolves.toEqual({ parentKind: "canvas", backgroundAgent: false, runSubstreamId: THREAD, authoritySubstreamId: THREAD });
    // An ordinary run's conversation is its own whatever the table says.
    expect(ownerOf).not.toHaveBeenCalled();
  });

  it("is the starting conversation's for a background agent, through every delegation above it", async () => {
    const ownerOf = owners([
      [agent(WORKSTREAM, NESTED_WORKER), agent(WORKSTREAM, WORKER)],
      [agent(WORKSTREAM, WORKER), agent(WORKSTREAM, THREAD)],
    ]);

    await expect(resolveTerminalRunScope(input(WORKER, true), ownerOf))
      .resolves.toEqual({ parentKind: "canvas", backgroundAgent: true, runSubstreamId: WORKER, authoritySubstreamId: THREAD });
    await expect(resolveTerminalRunScope(input(NESTED_WORKER, true), ownerOf))
      .resolves.toEqual({ parentKind: "canvas", backgroundAgent: true, runSubstreamId: NESTED_WORKER, authoritySubstreamId: THREAD });
  });

  it("shares the authoring sandbox across Sidekick activations without changing their run addresses", async () => {
    const ownerOf = owners([]);
    for (const substreamId of ["0", THREAD, WORKER]) {
      await expect(resolveTerminalRunScope({ ...input(substreamId, false), parentKind: "automation" }, ownerOf))
        .resolves.toEqual({ parentKind: "automation", backgroundAgent: false,
          runSubstreamId: substreamId, authoritySubstreamId: "0" });
    }
    expect(ownerOf).not.toHaveBeenCalled();
  });

  it("uses the same Sidekick sandbox for nested background agents", async () => {
    const sidekickAgent = (substreamId: string) => agentIdForAddress({
      parentKind: "automation", parentId: WORKSTREAM, substreamId: asSubstreamId(substreamId),
    });
    const ownerOf = owners([[sidekickAgent(NESTED_WORKER), sidekickAgent(WORKER)],
      [sidekickAgent(WORKER), sidekickAgent(THREAD)]]);
    await expect(resolveTerminalRunScope({ ...input(NESTED_WORKER, true), parentKind: "automation" }, ownerOf))
      .resolves.toEqual({ parentKind: "automation", backgroundAgent: true,
        runSubstreamId: NESTED_WORKER, authoritySubstreamId: "0" });
  });

  it("refuses a root under another parent rather than sharing files across work streams", async () => {
    const ownerOf = owners([[agent(WORKSTREAM, WORKER), agent(OTHER_WORKSTREAM, "0")]]);

    await expect(resolveTerminalRunScope(input(WORKER, true), ownerOf))
      .rejects.toThrow("terminal_authority_parent_mismatch");
  });

  it("validates a Sidekick worker's parent even though its sandbox address is always zero", async () => {
    const child = agentIdForAddress({ parentKind: "automation", parentId: WORKSTREAM, substreamId: asSubstreamId(WORKER) });
    const ownerOf = owners([[child, agent(OTHER_WORKSTREAM, "0")]]);
    await expect(resolveTerminalRunScope({ ...input(WORKER, true), parentKind: "automation" }, ownerOf))
      .rejects.toThrow("terminal_authority_parent_mismatch");
  });

  it("refuses an ownership cycle rather than walking it forever", async () => {
    const ownerOf = owners([
      [agent(WORKSTREAM, WORKER), agent(WORKSTREAM, NESTED_WORKER)],
      [agent(WORKSTREAM, NESTED_WORKER), agent(WORKSTREAM, WORKER)],
    ]);

    await expect(resolveTerminalRunScope(input(WORKER, true), ownerOf))
      .rejects.toThrow("terminal_authority_ownership_cycle");
  });
});
