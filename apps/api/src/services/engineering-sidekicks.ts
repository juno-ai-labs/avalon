import type {
  SetEngineeringSidekickPausedInput, SetEngineeringSidekickPausedResult,
} from "@rally/contracts/engineering-inspection";

import type { Env } from "../env";
import { AutomationService } from "./automation-service";
import { engineeringUserAuth } from "./engineering-creation";

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
  if (input.paused) await sidekicks.pause(input.sidekickId);
  else await sidekicks.resume(input.sidekickId);
  const { lifecycle } = await sidekicks.detail(input.sidekickId);
  return { region: env.AVALON_REGION, orgId: input.orgId, sidekickId: input.sidekickId, lifecycle };
}
