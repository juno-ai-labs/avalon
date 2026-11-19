import type { ArchiveEngineeringCanvasInput, ArchiveEngineeringCanvasResult } from "@rally/contracts/engineering-inspection";

import type { Env } from "../env";
import { CanvasService } from "./canvas-service";
import { engineeringUserAuth } from "./engineering-creation";

/**
 * Archive a Canvas as a selected user, through the service the app's Archive
 * action calls, so HostedCanvas's manager check, the Sidekicks made in it,
 * its conversations and artifacts, and the directory refresh all apply.
 * Archiving an archived Canvas changes nothing. There is no undo.
 */
export async function archiveEngineeringCanvas(
  env: Env, input: ArchiveEngineeringCanvasInput,
): Promise<ArchiveEngineeringCanvasResult> {
  const auth = await engineeringUserAuth(env, input.orgId, input.userId);
  await new CanvasService(env, auth).archive(input.canvasId);
  return { region: env.AVALON_REGION, orgId: input.orgId, canvasId: input.canvasId, archived: true };
}
