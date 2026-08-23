import {
  ExternalActorSchema,
  asWorkstreamId,
  type UserId,
  type WorkspaceId,
  type ExternalActor,
  type Scope,
  type SlackOriginContext,
  type SlackSearchAuthorization,
} from "@avalon/contracts";
import { createDatabase, newId, nowIso } from "@avalon/db";
import { z } from "zod";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { recordWorkstreamCreatedTelemetry } from "../telemetry/workstream-creation";
import { publishWorkstreamEvent } from "./integrations";
import { launchWorkstreamHarness } from "./workstream-service";
import { WorkstreamEmailRoutingService } from "./workstream-email-routing-service";
import { nameWorkstream, provisionalWorkstreamTitle } from "./workstream-naming-service";
import { createSchedulingObjectPort } from "../runtime/scheduling-port";
import { createMessageObjectPort } from "../runtime/message-port";
import { readMessage } from "../runtime/message-projection";
import {
  attachWorkstreamOriginResource,
  type OriginResourceDescriptor,
} from "./workstream-origin-resource";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  workstreamExecutionEnvironment,
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
    );
    const database = createDatabase(executionEnv.DB);
    const created = await database.workstreams.create({
      id: workstreamId,
      workspaceId: this.workspaceId,
      title,
      titleStatus: input.title == null ? "naming" : "settled",
      objective: input.objective,
      emailAddress: emailRoute.emailAddress,
      creatorUserId: input.creatorUserId ?? null,
      openingAuthor: { type: "external", actor },
      openingMessage: input.text,
      clientMessageId: input.clientMessageId,
      participantUserIds: input.participantUserIds ?? [],
      ...(input.scope ? { scope: input.scope } : {}),
    });
    await recordWorkstreamCreatedTelemetry(this.env, {
      workspaceId: this.workspaceId,
      workstreamId: created.workstream.id,
      creationSource: "slack_agent",
      connectorTypes: ["slack"],
      principal: input.creatorUserId
        ? { type: "user", userId: input.creatorUserId }
        : { type: "workspace" },
    });
    await emailRouting.activateWorkstreamRoute(routeInput);
    const message = await readMessage(
      createMessageObjectPort(this.env, this.workspaceId, created.workstream.id),
      { workspaceId: this.workspaceId, workstreamId: created.workstream.id },
      input.clientMessageId,
    );
    if (message) {
      await publishWorkstreamEvent(this.env, this.workspaceId, created.workstream.id, {
        type: "message_created",
        message,
      });
      await this.recordExternalActorAudit(
        "slack.workspace_workstream.created",
        created.workstream.id,
        "message",
        message.id,
        actor,
      );
    }
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
    const harnessRunId = await launchWorkstreamHarness(this.env, {
      workspaceId: this.workspaceId,
      workstreamId: asWorkstreamId(created.workstream.id),
      triggerMessageId: created.messageId,
      origin: "slack_workspace_opening_message",
      executionPrincipal: { type: "workspace", workspaceId: this.workspaceId },
      slackOrigin: input.slackOrigin,
      ...(input.slackSearchAuthorization
        ? { slackSearchAuthorization: input.slackSearchAuthorization }
        : {}),
    });
    // Slack ingress already runs inside the acknowledgement's `waitUntil`, so
    // naming is awaited here rather than deferred again — the run has started
    // and nothing downstream is waiting on the title.
    if (input.title == null) {
      await nameWorkstream(executionEnv, {
        workspaceId: this.workspaceId,
        workstreamId: created.workstream.id,
        objective: input.objective,
        openingMessage: input.text,
        provisionalTitle: title,
      });
    }
    return { ...created, harnessRunId };
  }

  async createMessage(workstreamId: string, input: SlackExternalMessageInput) {
    const identity = { workspaceId: this.workspaceId, workstreamId };
    const messages = createMessageObjectPort(this.env, this.workspaceId, workstreamId);
    // Slack redelivers. The client message id is the Slack event's, so a
    // redelivery resolves to the row the first delivery wrote — and the
    // difference between the two is what decides whether this starts a run.
    const appended = await messages.appendMessage({
      messageId: newId(),
      clientMessageId: input.clientMessageId,
      authorType: "external",
      authorUserId: null,
      externalActorJson: JSON.stringify(ExternalActorSchema.parse(input.actor)),
      messageType: "text",
      text: input.text,
      structuredContentJson: null,
      producedByRunId: null,
      now: Date.now(),
    });
    const message = await readMessage(messages, identity, input.clientMessageId);
    if (!message) throw new ApiError(500, "message_write_failed", "The message could not be stored");
    if (appended.outcome === "replayed") {
      return { message, harnessRunId: null };
    }
    await publishWorkstreamEvent(this.env, this.workspaceId, workstreamId, {
      type: "message_created",
      message,
    });
    await this.recordExternalActorAudit(
      "slack.workspace_workstream.message_created",
      workstreamId,
      "message",
      message.id,
      input.actor,
    );
    const harnessRunId = await launchWorkstreamHarness(this.env, {
      workspaceId: this.workspaceId,
      workstreamId: asWorkstreamId(workstreamId),
      triggerMessageId: message.id,
      origin: "slack_workspace_message",
      executionPrincipal: { type: "workspace", workspaceId: this.workspaceId },
      slackOrigin: input.slackOrigin,
      ...(input.slackSearchAuthorization
        ? { slackSearchAuthorization: input.slackSearchAuthorization }
        : {}),
      supersedeActiveRun: true,
    });
    return { message, harnessRunId };
  }

  async answerOpenElicitation(workstreamId: string, input: SlackExternalMessageInput) {
    const executionEnv = await workstreamExecutionEnvironment(this.env, this.workspaceId, workstreamId);
    const clientMessageId = input.clientMessageId.slice(0, 120);
    // The replay check only needs to know whether the row is there, so it reads
    // the row rather than a fully assembled message.
    const existing = await createMessageObjectPort(this.env, this.workspaceId, workstreamId)
      .messageByClientId({ clientMessageId });
    if (existing) return { elicitation: null, harnessRunId: null };
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
    const results = await executionEnv.DB.batch([
      executionEnv.DB.prepare(
        `UPDATE elicitations
         SET status = 'answered', answer_json = ?, answered_by_user_id = NULL,
             answered_by_external_actor_json = ?, answered_at = ?
         WHERE id = ? AND workspace_id = ? AND workstream_id = ? AND status = 'open'`,
      ).bind(
        JSON.stringify(answer),
        JSON.stringify(actor),
        at,
        elicitation.id,
        this.workspaceId,
        workstreamId,
      ),
      executionEnv.DB.prepare(
        `INSERT INTO messages
         (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
          message_type, text_content, structured_content_json, sequence_number, created_at,
          external_actor_json)
         SELECT ?, ?, ?, w.id, 'external', NULL, 'elicitation', '', ?,
                w.next_sequence_number, ?, ?
         FROM workstreams w
         WHERE w.id = ? AND w.workspace_id = ?
           AND EXISTS (
             SELECT 1 FROM elicitations e
             WHERE e.id = ? AND e.workspace_id = w.workspace_id AND e.workstream_id = w.id
               AND e.status = 'answered' AND e.answered_at = ?
               AND e.answered_by_external_actor_json = ?
           )
         ON CONFLICT(workstream_id, client_message_id) DO NOTHING`,
      ).bind(
        responseMessageId,
        clientMessageId,
        this.workspaceId,
        JSON.stringify({ kind: "elicitation_response", elicitation: persistedElicitation }),
        at,
        JSON.stringify(actor),
        workstreamId,
        this.workspaceId,
        elicitation.id,
        at,
        JSON.stringify(actor),
      ),
      executionEnv.DB.prepare(
        `UPDATE workstreams SET next_sequence_number = next_sequence_number + 1,
           latest_attention_sequence_number = next_sequence_number,
           last_activity_at = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?
           AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`,
      ).bind(at, at, workstreamId, this.workspaceId, responseMessageId),
    ]);
    if (Number(results[0]?.meta.changes ?? 0) !== 1) {
      throw new ApiError(409, "elicitation_already_answered", "This question was answered by someone else");
    }
    if (Number(results[1]?.meta.changes ?? 0) !== 1) {
      throw new ApiError(500, "elicitation_response_write_failed", "The response could not be stored");
    }
    const remaining = await scheduling.openElicitationCount();
    const harnessRunId = remaining === 0
      ? await launchWorkstreamHarness(this.env, {
          workspaceId: this.workspaceId,
          workstreamId: asWorkstreamId(workstreamId),
          triggerMessageId: responseMessageId,
          origin: "slack_workspace_elicitation_answer",
          executionPrincipal: { type: "workspace", workspaceId: this.workspaceId },
          slackOrigin: input.slackOrigin,
          ...(input.slackSearchAuthorization
            ? { slackSearchAuthorization: input.slackSearchAuthorization }
            : {}),
          parentHarnessRunId: elicitation.harness_run_id,
        })
      : null;
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
    return { elicitation: persistedElicitation, harnessRunId };
  }

  private async recordExternalActorAudit(
    action: string,
    workstreamId: string,
    targetType: "message" | "elicitation",
    targetId: string,
    actorInput: ExternalActor,
  ): Promise<void> {
    const actor = ExternalActorSchema.parse(actorInput);
    await this.env.DB.prepare(
      `INSERT INTO audit_events
       (id, workspace_id, actor_type, actor_user_id, workstream_id, action,
        target_type, target_id, metadata_json, created_at)
       VALUES (?, ?, 'connector', NULL, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      newId(),
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
