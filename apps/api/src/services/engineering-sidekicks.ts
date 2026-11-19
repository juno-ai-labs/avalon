import type {
  ArchiveEngineeringSidekickInput, ArchiveEngineeringSidekickResult,
  SetEngineeringSidekickPausedInput, SetEngineeringSidekickPausedResult,
} from "@rally/contracts/engineering-inspection";

import type { Env } from "../env";
import { AutomationService } from "./automation-service";
import { engineeringUserAuth } from "./engineering-user-auth";

/**
 * Pause or resume a Sidekick as a selected user, through the same service the
 * app's Pause and Resume buttons call. The Sidekick's own manager check, run
 * stop, alarm cancellation and registration clearing all apply unchanged.
 */
export async function setEngineeringSidekickPaused(
  env: Env, input: SetEngineeringSidekickPausedInput,
): Promise<SetEngineeringSidekickPausedResult> {
  const auth = await engineeringUserAuth(env, input.orgId, input.userId);
  const sidekicks = new AutomationService(env, auth);
  // Each returns only when the Sidekick ends in that state, and throws
  // otherwise, so the lifecycle needs no read-back.
  if (input.paused) await sidekicks.pause(input.sidekickId);
  else await sidekicks.resume(input.sidekickId);
  return {
    region: env.AVALON_REGION, orgId: input.orgId, sidekickId: input.sidekickId,
    lifecycle: input.paused ? "paused" : "active",
  };
}

/**
 * Archive a Sidekick as a selected user, through the service the app's
 * Archive action calls, so its manager check, run stop, alarm cancellation,
 * registration clearing and list refresh all apply. There is no undo.
 * It is the one tool that also acts in an abandoned Organization.
 */
export async function archiveEngineeringSidekick(
  env: Env, input: ArchiveEngineeringSidekickInput,
): Promise<ArchiveEngineeringSidekickResult> {
  const auth = await engineeringUserAuth(env, input.orgId, input.userId, { abandoned: "admit" });
  await new AutomationService(env, auth).archive(input.sidekickId);
  return { region: env.AVALON_REGION, orgId: input.orgId, sidekickId: input.sidekickId, lifecycle: "deleted" };
}
