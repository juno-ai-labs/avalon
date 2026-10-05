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
 * The Worker passes who is asking and nothing it concluded about them. Whether
 * they may manage a room's Sidekick, the room archived or not, is decided
 * where the Sidekick lives, from the Organization's own rows, so the service
 * makes one call and reads nothing first.
 */
describe("resolving the actor for a room's automation", () => {
  it("asks the Organization object once, with the caller and no participation of its own", async () => {
    const reads: string[] = [];
    const resumes: Array<{ automationId: string; actor: { userId: string; participantOfOwningWorkstream: boolean } }> = [];
    const env = createTestEnv({
      AVALON_REGION: "global",
      APP_ENV: "test",
      WORKSPACE_DOS: createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
        idFromName: (name: string) => createTestDurableObjectId(name),
        get: () => new Proxy({
          sidekickResume: async (request: { automationId: string; actor: { userId: string; participantOfOwningWorkstream: boolean } }) => {
            resumes.push(request);
          },
        }, {
          get: (target, property) => {
            if (typeof property === "string" && property !== "then" && !(property in target)) reads.push(property);
            return Reflect.get(target, property);
          },
        }),
      }),
    });

    await new AutomationService(env, auth).resume(AUTOMATION_ID);

    expect(reads).toEqual([]);
    expect(resumes).toEqual([expect.objectContaining({
      automationId: AUTOMATION_ID,
      actor: expect.objectContaining({ userId: USER_ID, participantOfOwningWorkstream: false }),
    })]);
  });
});
