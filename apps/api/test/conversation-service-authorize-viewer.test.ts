import {
  asAutomationId,
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
function organization(hosted: "workstream" | "automation" | null, decision: ViewerDecision) {
  return {
    resolveHostedParent: vi.fn(async (input: { viewer?: unknown }) => ({
      kind: hosted,
      authority: { exists: hosted !== null, authorityGeneration: 4, archived: false },
      ...(hosted !== null && input.viewer ? { viewer: decision } : {}),
    })),
    authorizeViewer: vi.fn(async (): Promise<ViewerDecision> => ({ authorized: true, archived: false })),
  };
}

function environment(workspace: ReturnType<typeof organization>) {
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
  });
  return { env, workspaceGets };
}

describe("ConversationService.authorizeViewer", () => {

  it("refuses a Channel viewer the Organization object turned away as not found", async () => {
    const workspace = organization("workstream", { authorized: false, archived: false });
    const { env } = environment(workspace);

    const refused = await new ConversationService(env, auth).authorizeViewer(channelId)
      .then(() => null, (error: unknown) => error);

    expect(refused).toMatchObject({ name: "ApiError", status: 404, code: "conversation_not_found" });
    expect(workspace.authorizeViewer).not.toHaveBeenCalled();
  });

  it("refuses a Sidekick viewer from the Organization's one answer, with the guest's grant rule", async () => {
    const workspace = organization("automation", { authorized: false, archived: false });
    const { env, workspaceGets } = environment(workspace);

    const refused = await new ConversationService(env, { ...auth, role: null }).authorizeViewer(sidekickId)
      .then(() => null, (error: unknown) => error);

    expect(refused).toMatchObject({ name: "ApiError", status: 404, code: "conversation_not_found" });
    expect(workspaceGets).toHaveBeenCalledTimes(1);
    expect(workspace.resolveHostedParent).toHaveBeenCalledWith({
      workspaceId, parentId: sidekickId, viewer: { userId, substreamId: "0", requireGrantAuthority: true },
    });
    expect(workspace.authorizeViewer).not.toHaveBeenCalled();
  });
});
