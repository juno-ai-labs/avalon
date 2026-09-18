import { asUserId, asWorkspaceId } from "@rally/contracts";
import { describe, expect, it } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { AutomationService } from "../src/services/automation-service";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ac01");
const USER_ID = asUserId("00000000-0000-7000-8000-00000000ac02");
const ROOM_ID = "00000000-0000-7000-8000-00000000ac03";
const AUTOMATION_ID = "00000000-0000-7000-8000-00000000ac04";

const auth: AuthContext = {
  sessionId: "session",
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  region: "global",
  role: "member",
  analyticsWorkspaceId: null,
};

/**
 * The Worker resolves who the caller is to the automation from the workspace
 * directory for routing and the canonical owner for management authority, and
 * the room being archived does not end that: the object is the one that says
 * what the archive forbids, and it can only say so if the caller reaches it.
 */
describe("resolving the actor for a room's automation", () => {
  it("preserves canonical management standing for an archived owning room", async () => {
    const participantReads: Array<Record<string, unknown>> = [];
    const resumes: Array<{ actor: { participantOfOwningWorkstream: boolean } }> = [];
    const env = createTestEnv({
      AVALON_REGION: "global",
      APP_ENV: "test",
      WORKSPACE_DOS: createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
        idFromName: (name: string) => createTestDurableObjectId(name),
        get: () => ({
          automationOwner: async () => ({ owningWorkstreamId: ROOM_ID }),
        }),
      }),
      WORKSTREAM_DOS: createCloudflareTestBinding<Env["WORKSTREAM_DOS"]>({
        idFromName: (name: string) => createTestDurableObjectId(name),
        get: () => ({
          readManagementAccess: async (request: Record<string, unknown>) => {
            participantReads.push(request);
            return { allowed: true, writable: false, grantIds: [], workspaceMemberAccess: false };
          },
        }),
      }),
      AUTOMATION_DOS: createCloudflareTestBinding<Env["AUTOMATION_DOS"]>({
        idFromName: (name: string) => createTestDurableObjectId(name),
        get: () => ({
          resume: async (request: { actor: { participantOfOwningWorkstream: boolean } }) => {
            resumes.push(request);
          },
        }),
      }),
    });

    await new AutomationService(env, auth).resume(AUTOMATION_ID);

    expect(participantReads).toEqual([{
      workspaceId: WORKSPACE_ID,
      parentId: ROOM_ID,
      userId: USER_ID,
    }]);
    expect(resumes).toEqual([expect.objectContaining({
      automationId: AUTOMATION_ID,
      actor: expect.objectContaining({ userId: USER_ID, participantOfOwningWorkstream: true }),
    })]);
  });
});
