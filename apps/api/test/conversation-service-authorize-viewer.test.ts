import {
  asAutomationId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
} from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { ConversationService } from "../src/services/conversation-service";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-00000000a001");
const userId = asUserId("00000000-0000-7000-8000-00000000a002");
const channelId = asWorkstreamId("00000000-0000-7000-8000-00000000a003");
const sidekickId = asAutomationId("00000000-0000-7000-8000-00000000a004");
const breakoutId = asSubstreamId("00000000-0000-7000-8000-00000000a005");
const auth: AuthContext = { sessionId: "session-1", userId, workspaceId, region: "global", role: "member" };

type ViewerDecision = { authorized: boolean; archived: boolean; membershipVersion?: number };

/**
 * The Organization object as the Worker sees it. `resolveHostedParent` answers
 * for a Channel with the viewer's decision when it was asked about a viewer,
 * and for an id it does not host with no kind, the way the real one does in
 * `test-workers/conversation-parent-contract`. `authorizeViewer` is here so a
 * second round trip is observable, not because a Channel should need it; it
 * admits everyone, so only the resolve's own decision can refuse a viewer.
 */
function organization(hosted: "workstream" | null, decision: ViewerDecision) {
  return {
    resolveHostedParent: vi.fn(async (input: { viewer?: unknown }) => ({
      kind: hosted,
      authority: { exists: hosted !== null, authorityGeneration: 4, archived: false },
      ...(hosted !== null && input.viewer ? { viewer: decision } : {}),
    })),
    authorizeViewer: vi.fn(async (): Promise<ViewerDecision> => ({ authorized: true, archived: false })),
  };
}

function sidekick(decision: ViewerDecision) {
  return {
    authority: vi.fn(async () => ({ exists: true, authorityGeneration: 2, archived: false })),
    authorizeViewer: vi.fn(async () => decision),
  };
}

function environment(workspace: ReturnType<typeof organization>, automation?: ReturnType<typeof sidekick>) {
  const workspaceGets = vi.fn(() => workspace);
  const env = createTestEnv({
    APP_ENV: "test",
    AVALON_REGION: "global",
    // Placement affinity is the only D1 read on this path; no row is the default.
    DB: createTestD1Database({ prepare: () => createTestD1PreparedStatement({ first: async () => null }) }),
    WORKSPACE_DOS: createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
      idFromName: () => createTestDurableObjectId("workspace"),
      get: workspaceGets,
    }),
    AUTOMATION_DOS: createCloudflareTestBinding<Env["AUTOMATION_DOS"]>({
      idFromName: () => createTestDurableObjectId("automation"),
      get: () => {
        if (!automation) throw new Error("a Channel must not address an AutomationDO");
        return automation;
      },
    }),
  });
  return { env, workspaceGets };
}

describe("ConversationService.authorizeViewer", () => {
  it("opens a Channel conversation with one Organization call that carries the viewer's decision", async () => {
    const workspace = organization("workstream", { authorized: true, archived: false, membershipVersion: 6 });
    const { env, workspaceGets } = environment(workspace);

    const parent = await new ConversationService(env, auth).authorizeViewer(channelId, breakoutId);

    expect(parent).toMatchObject({
      kind: "workstream", id: channelId, authorityGeneration: 4, archived: false, membershipVersion: 6,
    });
    expect(workspaceGets).toHaveBeenCalledTimes(1);
    expect(workspace.resolveHostedParent).toHaveBeenCalledTimes(1);
    expect(workspace.resolveHostedParent).toHaveBeenCalledWith({
      workspaceId, parentId: channelId, viewer: { userId, substreamId: breakoutId },
    });
    expect(workspace.authorizeViewer).not.toHaveBeenCalled();
  });

  it("refuses a Channel viewer the Organization object turned away as not found", async () => {
    const workspace = organization("workstream", { authorized: false, archived: false });
    const { env } = environment(workspace);

    const refused = await new ConversationService(env, auth).authorizeViewer(channelId)
      .then(() => null, (error: unknown) => error);

    expect(refused).toMatchObject({ name: "ApiError", status: 404, code: "conversation_not_found" });
    expect(workspace.authorizeViewer).not.toHaveBeenCalled();
  });

  it("still asks a Sidekick parent's own object whether the viewer may read it", async () => {
    const workspace = organization(null, { authorized: true, archived: false });
    const automation = sidekick({ authorized: false, archived: false });
    const { env } = environment(workspace, automation);

    const refused = await new ConversationService(env, { ...auth, role: null }).authorizeViewer(sidekickId)
      .then(() => null, (error: unknown) => error);

    expect(refused).toMatchObject({ name: "ApiError", status: 404, code: "conversation_not_found" });
    expect(workspace.resolveHostedParent).toHaveBeenCalledTimes(1);
    expect(workspace.authorizeViewer).not.toHaveBeenCalled();
    expect(automation.authorizeViewer).toHaveBeenCalledTimes(1);
    expect(automation.authorizeViewer).toHaveBeenCalledWith({
      workspaceId, parentId: sidekickId, userId, substreamId: "0", requireGrantAuthority: true,
    });
  });
});
