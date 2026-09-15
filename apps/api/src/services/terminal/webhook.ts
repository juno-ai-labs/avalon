import { z } from "zod";
import type { Env } from "../../env";
import { ApiError } from "../../lib/api-error";
import { verifySvixSignature } from "../../lib/svix-signature";
import { resolveInspectionWorkspaceRoute } from "../../engineering-inspection-routes";
import { parseTerminalRegionConfiguration } from "./contract";
import { createTerminalPortFactory } from "./object-port";
import { createTerminalProviderRpcClient } from "./provider-rpc-client";
import { observeTerminalSandbox } from "./provider-contract";
import { refreshTerminalProviderObservation } from "./observation";

const EventSchema = z.object({
  event: z.string(), id: z.string().min(1), organizationId: z.string().min(1),
});
const LabelsSchema = z.object({
  "rally.workspace": z.string().uuid(),
  "rally.workstream": z.string().uuid(),
  "rally.generation": z.string().regex(/^[1-9]\d*$/u).transform(Number).pipe(z.number().safe()),
});

/** Events are invalidation hints, never commands or authoritative state transitions. */
export async function ingestDaytonaWebhook(env: Env, rawBody: string, headers: Headers) {
  if (!env.DAYTONA_WEBHOOK_SECRET || !env.DAYTONA_ORGANIZATION_ID) {
    throw new ApiError(503, "daytona_webhook_unavailable", "Daytona webhooks are not configured");
  }
  await verifySvixSignature({
    secret: env.DAYTONA_WEBHOOK_SECRET, rawBody, id: headers.get("svix-id"),
    timestamp: headers.get("svix-timestamp"), signature: headers.get("svix-signature"),
    now: Date.now(), replayWindowSeconds: 300, // Svix's standard five-minute replay window.
  });
  let payload: unknown;
  try { payload = JSON.parse(rawBody); } catch {
    throw new ApiError(400, "invalid_webhook", "Invalid Daytona JSON");
  }
  const parsed = EventSchema.safeParse(payload);
  if (!parsed.success) throw new ApiError(400, "invalid_webhook", "Invalid Daytona event");
  const event = parsed.data;
  if (event.organizationId !== env.DAYTONA_ORGANIZATION_ID) {
    throw new ApiError(403, "daytona_organization_mismatch", "Unexpected Daytona organization");
  }
  if (!["sandbox.created", "sandbox.state.updated"].includes(event.event)) {
    return { accepted: true, ignored: true };
  }
  const configuration = parseTerminalRegionConfiguration(env);
  if (configuration.capability !== "supported") {
    throw new ApiError(503, "daytona_webhook_unavailable", "Daytona is not configured");
  }
  const provider = createTerminalProviderRpcClient(env.TERMINAL_PROVIDER, configuration);
  // Daytona events carry an ID, not routing labels. Metadata identifies the owner.
  // Deleted sandboxes have no metadata; the owner's periodic observation detects
  // their absence. This avoids maintaining a second sandbox ownership database.
  const snapshot = await observeTerminalSandbox(provider, event.id);
  const labels = LabelsSchema.safeParse(snapshot?.labels);
  if (!labels.success) return { accepted: true, ignored: true };
  const workspaceId = labels.data["rally.workspace"];
  const workstreamId = labels.data["rally.workstream"];
  if (!await resolveInspectionWorkspaceRoute(env, workspaceId)) {
    // Each region subscribes to the organization; only the owning region acts.
    return { accepted: true, ignored: true };
  }
  const terminal = createTerminalPortFactory(env)(workspaceId, workstreamId);
  const current = await terminal.sandbox();
  if (current?.sandboxId !== event.id || current.generation !== labels.data["rally.generation"]) {
    return { accepted: true, ignored: true };
  }
  // Read again after reserving ordering in the authority. Reusing the routing
  // lookup would allow an older event handler to overwrite a newer observation.
  await refreshTerminalProviderObservation(terminal, provider, {
    sandboxId: event.id, generation: current.generation,
  });
  return { accepted: true, ignored: false };
}
