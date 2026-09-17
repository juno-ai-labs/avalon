import {
  ExternalActorSchema,
  asWorkstreamId,
  type UserId,
  type WorkspaceId,
  type ExternalActor,
  type Scope,
  type SlackOriginContext,
  type SlackSearchAuthorization,
} from "@rally/contracts";
import { newId, nowIso } from "@rally/db";
import { z } from "zod";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { sha256Hex } from "../lib/crypto";
import { runtimeDeferral } from "../lib/defer";
import { recordWorkstreamCreatedTelemetry } from "../telemetry/workstream-creation";
import { publishWorkstreamEvent } from "./integrations";
import {
  admitExternalWorkstreamMessage,
  answerExternalWorkstreamElicitation,
} from "./workstream-service";
import { WorkstreamEmailRoutingService } from "./workstream-email-routing-service";
import { nameWorkstream, provisionalWorkstreamTitle } from "./workstream-naming-service";
import { createSchedulingObjectPort } from "../runtime/scheduling-port";
import { createMessageObjectPort } from "../runtime/message-port";
import {
  attachWorkstreamOriginResource,
  type OriginResourceDescriptor,
} from "./workstream-origin-resource";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
} from "./workstream-runtime-database";

const OpenElicitationRowSchema = z.object({
  id: z.string().min(1),
  harness_run_id: z.string().min(1),
  prompt: z.string(),
  response_type: z.enum(["text", "radio", "single_select", "multi_select"]),
  options_json: z.string(),
  minimum_selections: z.number().int(),
  maximum_selections: z.number().int().nullable(),
  created_at: z.string(),
});

type SlackExternalMessageInput = {
  actor: ExternalActor;
  text: string;
  clientMessageId: string;
  slackOrigin: SlackOriginContext;
  slackSearchAuthorization?: SlackSearchAuthorization;
};

/**
 * Narrow host-authorized surface for Slack members who are not Avalon users.
 * Every run uses the workspace principal; the Slack identity is attribution,
 * never an authentication substitute.
 */
export class SlackWorkspaceWorkstreamService {
  constructor(
    private readonly env: Env,
    private readonly workspaceId: WorkspaceId,
  ) {}

  /**
   * `creatorUserId` is the Avalon member the Slack identity resolves to, when
   * the installation can make that mapping. It is attribution only: the run
   * still uses the workspace principal, and the opening message keeps its
   * external Slack authorship.
   */
  async create(input: SlackExternalMessageInput & {
    title?: string;
    objective: string;
    creatorUserId?: UserId | null;
    originResource?: OriginResourceDescriptor;
    /**
     * The conversation's own audience, carried onto the work stream. A private
     * Slack channel opens a private work stream whose room is
     * `participantUserIds` — see `connector-workstream-audience.ts`.
     */
    scope?: Scope;
    participantUserIds?: string[];
  }) {
    const actor = ExternalActorSchema.parse(input.actor);
    const title = input.title ?? provisionalWorkstreamTitle(input.objective, "Slack task");
    const workstreamId = newId();
    const routeInput = {
      region: this.env.AVALON_REGION,
      workspaceId: this.workspaceId,
      workstreamId,
    } as const;
    const emailRouting = new WorkstreamEmailRoutingService(this.env);
    const emailRoute = await emailRouting.reserve(routeInput);
    const executionEnv = await bootstrapWorkstreamRuntimeEnvironment(
      this.env,
      this.workspaceId,
      workstreamId,
      "workstream",
    );
    // The repository's `create` batched the root, its participants and the
    // opening message through the retired compatibility views, and had to
    // state `next_sequence_number = 2` and `latest_attention_sequence_number
    // = 1` itself because the message rode in the same batch. Each half is its
    // own authority's now, and the transcript takes its own sequence number.
    const at = Date.now();
    const creatorUserId = input.creatorUserId ?? null;
    await provisionWorkstreamObject(this.env, {
      workspaceId: this.workspaceId,
      workstreamId,
      title,
      titleStatus: input.title == null ? "naming" : "settled",
      objective: input.objective,
      scope: input.scope ?? "personal",
      createdByUserId: creatorUserId,
      participantUserIds: [
        ...new Set([...(creatorUserId ? [creatorUserId] : []), ...(input.participantUserIds ?? [])]),
      ],
      harnessStatus: "scheduled",
      emailAddress: emailRoute.emailAddress,
      emailRouteStatus: "reserved",
      systemKind: null,
      modelOverride: null,
      now: at,
    });
    const openingMessageId = newId();
    const created = { workstream: { id: workstreamId, createdByUserId: creatorUserId } };
    runtimeDeferral(recordWorkstreamCreatedTelemetry(this.env, {
      workspaceId: this.workspaceId,
      workstreamId: created.workstream.id,
      creationSource: "slack_agent",
      connectorTypes: ["slack"],
      principal: input.creatorUserId
        ? { type: "user", userId: input.creatorUserId }
        : { type: "workspace" },
    }));
    await emailRouting.activateWorkstreamRoute(routeInput);
    // Before the launch, so the run's first context read already holds the
    // Slack thread it was summoned from. The attribution matches the work
    // stream's: an unmapped Slack member is not an Avalon user and leaves the
    // attachment ownerless rather than crediting it to nobody in particular.
    if (input.originResource) {
      await attachWorkstreamOriginResource(this.env, {
        workspaceId: this.workspaceId,
        workstreamId: created.workstream.id,
        attachedByUserId: input.creatorUserId ?? null,
        descriptor: input.originResource,
      });
    }
    const admitted = await admitExternalWorkstreamMessage(this.env, {
      workspaceId: this.workspaceId,
      workstreamId: asWorkstreamId(created.workstream.id),
      messageId: openingMessageId,
      clientMessageId: input.clientMessageId,
      actor,
      messageType: "text",
      text: input.text,
      structuredContentJson: null,
      origin: "slack_workspace_opening_message",
      executionPrincipal: { type: "workspace", workspaceId: this.workspaceId },
      slackOrigin: input.slackOrigin,
      ...(input.slackSearchAuthorization
        ? { slackSearchAuthorization: input.slackSearchAuthorization }
        : {}),
      runMode: "steer",
      now: at,
    });
    await this.recordExternalActorAudit(
      "slack.workspace_workstream.created",
      created.workstream.id,
      "message",
      admitted.turn.turnId,
      actor,
    );
    // Slack ingress already runs inside the acknowledgement's `waitUntil`, so
    // naming is awaited here rather than deferred again. The opening message
    // is durable pending input by this point; no execution receipt exists yet.
    if (input.title == null) {
      await nameWorkstream(executionEnv, {
        workspaceId: this.workspaceId,
        workstreamId: created.workstream.id,
        objective: input.objective,
        openingMessage: input.text,
        provisionalTitle: title,
      });
    }
    return created;
  }

  async createMessage(workstreamId: string, input: SlackExternalMessageInput) {
    const admitted = await admitExternalWorkstreamMessage(this.env, {
      workspaceId: this.workspaceId,
      workstreamId: asWorkstreamId(workstreamId),
      messageId: newId(),
      clientMessageId: input.clientMessageId,
      actor: ExternalActorSchema.parse(input.actor),
      messageType: "text",
      text: input.text,
      structuredContentJson: null,
      origin: "slack_workspace_message",
      executionPrincipal: { type: "workspace", workspaceId: this.workspaceId },
      slackOrigin: input.slackOrigin,
      ...(input.slackSearchAuthorization
        ? { slackSearchAuthorization: input.slackSearchAuthorization }
        : {}),
      runMode: "steer",
      now: Date.now(),
    });
    await this.recordExternalActorAudit(
      "slack.workspace_workstream.message_created",
      workstreamId,
      "message",
      admitted.turn.turnId,
      input.actor,
    );
    return {
      message: { id: admitted.turn.turnId, clientMessageId: admitted.turn.clientMessageId },
      deliveryState: admitted.deliveryState,
    };
  }

  async answerOpenElicitation(workstreamId: string, input: SlackExternalMessageInput) {
    const clientMessageId = input.clientMessageId.slice(0, 120);
    // The replay check only needs to know whether the row is there, so it reads
    // the row rather than a fully assembled message.
    const existing = await createMessageObjectPort(this.env, this.workspaceId, workstreamId)
      .messageByClientId({ clientMessageId });
    if (existing) return { elicitation: null };
    const scheduling = createSchedulingObjectPort(this.env, this.workspaceId, workstreamId);
    const raw = await scheduling.oldestOpenElicitation();
    if (!raw) return null;
    // The object's columns, named as this path already names them. The view
    // renamed `elicitation_id` and `run_id` and rendered the instant as
    // ISO-8601; the last of those is a boundary format here, because the
    // rendered elicitation goes into a transcript payload a client reads.
    const elicitation = OpenElicitationRowSchema.parse({
      id: raw.elicitation_id,
      harness_run_id: raw.run_id,
      prompt: raw.prompt,
      response_type: raw.response_type,
      options_json: raw.options_json,
      minimum_selections: raw.minimum_selections,
      maximum_selections: raw.maximum_selections,
      created_at: new Date(raw.created_at).toISOString(),
    });
    const actor = ExternalActorSchema.parse(input.actor);
    const answer = slackElicitationAnswer(elicitation, input.text);
    const at = nowIso();
    const responseMessageId = newId();
    const persistedElicitation = {
      id: elicitation.id,
      workstreamId,
      harnessRunId: elicitation.harness_run_id,
      prompt: elicitation.prompt,
      responseType: elicitation.response_type,
      options: parseOptions(elicitation.options_json),
      minimumSelections: elicitation.minimum_selections,
      maximumSelections: elicitation.maximum_selections,
      targetUserId: null,
      status: "answered" as const,
      answer,
      answeredByUserId: null,
      createdAt: elicitation.created_at,
      answeredAt: at,
    };
    await answerExternalWorkstreamElicitation(this.env, {
      workspaceId: this.workspaceId,
      workstreamId: asWorkstreamId(workstreamId),
      elicitationId: elicitation.id,
      answerJson: JSON.stringify(answer),
      messageId: responseMessageId,
      clientMessageId,
      actor,
      messageType: "elicitation",
      text: "",
      structuredContentJson: JSON.stringify({
        kind: "elicitation_response",
        elicitation: persistedElicitation,
      }),
      origin: "slack_workspace_elicitation_answer",
      executionPrincipal: { type: "workspace", workspaceId: this.workspaceId },
      parentHarnessRunId: elicitation.harness_run_id,
      slackOrigin: input.slackOrigin,
      ...(input.slackSearchAuthorization
        ? { slackSearchAuthorization: input.slackSearchAuthorization }
        : {}),
      runMode: "steer",
      now: Date.parse(at),
    });
    // The routed batch fenced its update on `status = 'open'` and read
    // `meta.changes` to find out whether it had won the race; losing it is an
    // ordinary outcome, and the authority names it rather than reporting a
    // row count for the caller to interpret.
    await publishWorkstreamEvent(this.env, this.workspaceId, workstreamId, {
      type: "elicitation_answered",
      elicitation: persistedElicitation,
    });
    await this.recordExternalActorAudit(
      "slack.workspace_workstream.elicitation_answered",
      workstreamId,
      "elicitation",
      elicitation.id,
      actor,
    );
    return { elicitation: persistedElicitation };
  }

  private async recordExternalActorAudit(
    action: string,
    workstreamId: string,
    targetType: "message" | "elicitation",
    targetId: string,
    actorInput: ExternalActor,
  ): Promise<void> {
    const actor = ExternalActorSchema.parse(actorInput);
    const auditId = `slack:${await sha256Hex(JSON.stringify([
      this.workspaceId,
      workstreamId,
      action,
      targetType,
      targetId,
    ]))}`;
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO audit_events
       (id, workspace_id, actor_type, actor_user_id, workstream_id, action,
        target_type, target_id, metadata_json, created_at)
       VALUES (?, ?, 'connector', NULL, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      auditId,
      this.workspaceId,
      workstreamId,
      action,
      targetType,
      targetId,
      JSON.stringify({ externalActor: actor, executionPrincipal: "workspace" }),
      nowIso(),
    ).run();
  }
}

function parseOptions(value: string): Array<{ value: string; label: string; description?: string | null }> {
  const json: unknown = (() => {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  })();
  const parsed = z.array(z.object({
    value: z.string(),
    label: z.string(),
    description: z.string().nullable().optional(),
  })).safeParse(json);
  return parsed.success
    ? parsed.data.map((option) => ({
        value: option.value,
        label: option.label,
        ...(option.description !== undefined ? { description: option.description } : {}),
      }))
    : [];
}

function slackElicitationAnswer(
  elicitation: z.infer<typeof OpenElicitationRowSchema>,
  text: string,
): string | string[] {
  const response = text.trim();
  if (!response) throw new ApiError(422, "slack_prompt_missing", "The Slack response is empty");
  if (elicitation.response_type === "text") return response;
  const options = parseOptions(elicitation.options_json);
  const valuesByLabel = new Map(options.flatMap((option) => [
    [option.value.toLocaleLowerCase(), option.value] as const,
    [option.label.toLocaleLowerCase(), option.value] as const,
  ]));
  if (elicitation.response_type !== "multi_select") {
    if (elicitation.minimum_selections > 1 || elicitation.maximum_selections === 0) {
      throw new ApiError(422, "invalid_selection_count", "The Slack response has an invalid number of selections");
    }
    return valuesByLabel.get(response.toLocaleLowerCase()) ?? response;
  }
  const selections = response.split(/\s*,\s*/u).filter(Boolean);
  const matched = selections.map((selection) =>
    valuesByLabel.get(selection.toLocaleLowerCase()) ?? selection);
  const answer = matched.length > 0 ? matched : [response];
  if (answer.length < elicitation.minimum_selections
    || (elicitation.maximum_selections != null && answer.length > elicitation.maximum_selections)) {
    throw new ApiError(422, "invalid_selection_count", "The Slack response has an invalid number of selections");
  }
  return answer;
}
