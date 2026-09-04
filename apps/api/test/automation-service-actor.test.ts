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
 * directory. A room's automation is managed by the room's participants, and
 * the room being archived does not end that: the object is the one that says
 * what the archive forbids, and it can only say so if the caller reaches it.
 */
describe("resolving the actor for a room's automation", () => {
  it("counts a participant of the archived owning room as its manager", async () => {
    const participantReads: Array<Record<string, unknown>> = [];
    const resumes: Array<{ actor: { participantOfOwningWorkstream: boolean } }> = [];
    const env = createTestEnv({
      AVALON_REGION: "global",
      APP_ENV: "test",
      WORKSPACE_DOS: createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
        idFromName: (name: string) => createTestDurableObjectId(name),
        get: () => ({
          automationOwner: async () => ({ owningWorkstreamId: ROOM_ID }),
          workstreamParticipant: async (request: Record<string, unknown>) => {
            participantReads.push(request);
            // What WorkspaceDO answers for an archived room's participant with
            // and without the archive included.
            return { participant: request.includeArchived === true };
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
      workstreamId: ROOM_ID,
      userId: USER_ID,
      includeArchived: true,
    }]);
    expect(resumes).toEqual([expect.objectContaining({
      automationId: AUTOMATION_ID,
      actor: expect.objectContaining({ userId: USER_ID, participantOfOwningWorkstream: true }),
    })]);
  });
});
