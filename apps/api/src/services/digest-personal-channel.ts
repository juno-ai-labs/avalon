import { asSpaceId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { newId } from "@rally/db";

import type { Env } from "../env";
import { workspaceDOName } from "../durable-objects/names";
import { WorkspaceChannelReservationResultSchema } from "../durable-objects/workspace-space-protocol";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { stableUuid } from "../lib/stable-uuid";
import { createMessageObjectPort } from "../runtime/message-port";
import { readWorkstreamAuthorityControl } from "./workstream-authority";
import { bootstrapWorkstreamRuntimeEnvironment, provisionWorkstreamObject } from "./workstream-runtime-database";

/**
 * One digest as a new thread in its owner's Personal Channel, holding one
 * message from Rally and no run. Nobody created it, so it reaches the owner
 * unread and unseen like any message Rally writes, and no `thread_started`
 * row tells them about it.
 *
 * Every step is keyed on the delivery, so a retry after a partial attempt
 * lands on the same thread and the same message: the reservation and the
 * provisioning replay, and the message's client id makes its append replay.
 */
export async function postDigestToPersonalChannel(env: Env, input: {
  workspaceId: string;
  userId: string;
  spaceId: string;
  deliveryId: string;
  title: string;
  markdown: string;
}): Promise<void> {
  const workstreamId = await stableUuid(["digest_thread", input.deliveryId]);
  const createdAt = Date.now();
  await bootstrapWorkstreamRuntimeEnvironment(env, input.workspaceId, workstreamId, "workstream");
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    asWorkspaceId(input.workspaceId),
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(input.workspaceId)),
  );
  const reserved = WorkspaceChannelReservationResultSchema.parse(await workspace.reserveChannelInSpaces({
    workspaceId: asWorkspaceId(input.workspaceId),
    userId: asUserId(input.userId),
    workstreamId: asWorkstreamId(workstreamId),
    spaceIds: [asSpaceId(input.spaceId)],
    requestedScope: "personal",
    requestedParticipantUserIds: [asUserId(input.userId)],
    authorityGeneration: (await readWorkstreamAuthorityControl(env)).generation,
    directory: {
      title: input.title,
      description: "",
      emailAddress: null,
      titleStatus: "settled",
      createdAt: new Date(createdAt).toISOString(),
    },
    createdByUserId: null,
  }));
  if (reserved.status !== "reserved") {
    const code = reserved.status === "refused" ? reserved.code : reserved.status;
    // Spaces still being set up for this Organization will be ready for a
    // later occurrence. Anything else (the Space is gone, or no longer theirs)
    // will not change, so the destination is parked for the person to see.
    throw new ApiError(422, `personal_channel_${code}`, "Your Personal Channel is not available", {
      retryable: code === "space_bootstrap_pending",
    });
  }
  await provisionWorkstreamObject(env, {
    workspaceId: input.workspaceId,
    workstreamId,
    title: input.title,
    titleStatus: "settled",
    objective: "",
    scope: "personal",
    createdByUserId: null,
    participantUserIds: [input.userId],
    harnessStatus: "idle",
    emailAddress: null,
    emailRouteStatus: null,
    systemKind: null,
    modelOverride: null,
    color: reserved.color ?? null,
    now: createdAt,
  });
  await createMessageObjectPort(env, input.workspaceId, workstreamId).appendMessage({
    messageId: newId(),
    clientMessageId: `digest:${input.deliveryId}`,
    authorType: "agent",
    authorUserId: null,
    externalActorJson: null,
    messageType: "text",
    text: input.markdown,
    structuredContentJson: null,
    producedByRunId: null,
    now: Date.now(),
  });
}
