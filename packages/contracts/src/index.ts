export * from './artifact-picker';
import { AnnotationsSchema, validateAnnotationAttachments } from './artifact-annotations';
export * from './artifact-annotations';
import { ExternalPeopleSchema } from "./external-people";
export { ExternalPeopleSchema, ExternalPersonSchema, MAX_EXTERNAL_PEOPLE, deduplicateExternalPeople } from "./external-people";
import { z } from "zod";
import { AttachmentKindSchema, ResourceSlugSchema, parseStoredSuggestedAttachmentToolCall } from "./attachment-contracts";
import { AutomationLifecycleStateSchema,
  AutomationRunReferenceV1Schema,
  AutomationRunTriggerV1Schema,
  AutomationScopeSchema } from "./automation-agent";
import { ConnectorInstallationSchema } from "./connector-installation";
export * from "./conversation-attention";
export * from "./conversation-source";
import { HarnessStatusSchema } from "./conversation-attention";
export * from "./agent-communication";
import { AgentExchangeSchema } from "./agent-communication";
import { ConnectorOAuthProviders } from "./connector-oauth-providers";
import { DemoSeedSchema } from "./demo-seed";
import { DesktopActionOutcomeSchema, DesktopActionRequestSchema } from "./desktop-actions";
import {
  ActivitySourceBindingKeySchema,
  HarnessRunIdSchema,
  IdSchema,
  ModelPluginIdSchema,
  SubstreamIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
} from "./identifiers";
import { MESSAGE_MAX_CHARACTERS } from "./message-limits";
import { PersonalPresentationSchema } from './onboarding';
import { ChannelMessageSchema, PersonalOrderSchema, PinnedOrderSchema, SpaceIdSchema, SpaceSnapshotSchema } from "./spaces";
import { ArtifactPinListSchema, ChannelStatsSchema, PinListSchema } from "./navigation";
import {
  ResourceDirectionSchema,
  WireResourceRelationshipTypeSchema,
} from "./resource-relationships";
import { HttpsUrlSchema, httpsUrlSchema, HttpUrlSchema, httpUrlSchema, WebSocketUrlSchema } from "./url-schemas";
import { ConversationAccessRequestItemSchema } from "./access-requests";
import { PickableWorkstreamIconKeySchema, WorkstreamAppearanceSchema, WorkstreamAppearancePatchSchema, WorkstreamIconKeySchema } from "./workstream-appearance";
import {
  TranscriptActivitySchema,
  PendingTranscriptInputSchema,
  TranscriptRangeResultSchema,
  TranscriptTurnIdSchema,
  TranscriptTurnSchema,
  WorkstreamTranscriptRangeRequestSchema,
  WorkstreamTranscriptSnapshotSchema,
} from "./workstream-transcript";
export * from "./automation-agent";
export * from "./automation-evaluators";
export * from "./connector-connection-card";
export * from "./conversation-effects";
export * from "./conversation-parent";
export * from "./demo-operations";
export * from "./demo-seed";
export * from "./identifiers";
export * from "./impersonation";
export * from "./support-access";
export * from './onboarding';
export * from "./workspace-retirement";
export * from "./appearance-icons";
export * from "./workstream-appearance";
export * from "./access-requests";
export * from "./workstream-transcript";

import type { AutomationSetEvaluatorRulesInputV1 } from "./automation-evaluators";
import { ConversationParentKindSchema } from "./conversation-parent";
import { RegionSchema, ConfiguredRegionSchema } from "./regions";

export * from "./artifacts";
export * from "./attachment-contracts";
export * from "./palette";
export * from "./projects";
export * from "./resource-relationships";
export * from "./spaces";
export * from "./conversation-merge";
export * from "./conversation-suggestions";
import { ConversationSuggestionSchema } from "./conversation-suggestions";
export { MentionSchema } from "./mention-schema";
import { MentionSchema } from "./mention-schema";
export * from "./navigation";
export * from "./memory";

export { ConnectorOAuthProviders } from "./connector-oauth-providers";
export { parseDesktopDeepLinkIntent,type DesktopDeepLinkIntent } from "./desktop-deep-link-intent";
export { ConfiguredRegionSchema,RegionSchema,configuredRegions,isConfiguredRegion,regionConfiguration } from "./regions";
export {
AnonymousTelemetryBatchSchema,
isRetiredMeetingTelemetry,
CrashIngestResponseSchema,
LinkAnonymousTelemetryResponseSchema,ProductAnalyticsPreferenceSchema,TELEMETRY_APPLICATION_ICON_IDS,TELEMETRY_BATCH_MAX_BYTES,
TELEMETRY_CATEGORIES,TELEMETRY_CONNECTOR_TYPES,TELEMETRY_ENVELOPE_SCHEMA,TELEMETRY_EVENTS,
TELEMETRY_IDENTITY_SCOPES,TELEMETRY_MENU_BAR_ACTIONS,TELEMETRY_SOURCES,TelemetryAcceptanceBatchResponseSchema,
TelemetryAcceptanceResultSchema,TelemetryBatchSchema,TelemetryBootstrapRequestSchema,
TelemetryBootstrapResponseSchema,TelemetryBreadcrumbSchema,
TelemetryBreadcrumbSidecarSchema,
TelemetryEnvelopeSchema,TelemetryRouteResponseSchema,UpdateProductAnalyticsPreferenceSchema,telemetryEventNames,type AnonymousTelemetryBatch,
type CrashIngestResponse,
type LinkAnonymousTelemetryResponse,type ProductAnalyticsPreference,type TelemetryAcceptanceBatchResponse,
type TelemetryAcceptanceResult,type TelemetryApplicationIconId,type TelemetryBatch,type TelemetryBootstrapRequest,
type TelemetryBootstrapResponse,type TelemetryBreadcrumb,
type TelemetryBreadcrumbSidecar,type TelemetryCategory,
type TelemetryEnvelope,
type TelemetryEventName,
type TelemetryEventProperties,
type TelemetryIdentityScope,type TelemetryMenuBarAction,type TelemetryRouteResponse,type TelemetrySource
} from "./telemetry";
export {
addWorkspaceTarget,
assertWorkspaceTarget,
isWorkspaceTarget,
parseWorkspaceAddressedDeepLink,
parseWorkspaceTarget,
parseWorkspaceTargetParameters,
workspaceTargetsEqual,
type WorkspaceAddressedDeepLink,
type WorkspaceTarget,
type WorkspaceTargetRegion
} from "./workspace-target";
export {
LEGACY_WORKSTREAM_LINK_ORIGINS,LEGACY_WORKSTREAM_LINK_PATH_PREFIX,WORKSTREAM_LINK_PATH_PREFIX,
isWorkstreamId,
parseWorkstreamLink,parseWorkstreamLinkPath,
parseSidekickLinkPathTarget,parseSpaceLinkPathTarget,parseWorkstreamLinkPathTarget,parseWorkstreamLinkTarget,sidekickCanonicalUrl,sidekickDeepLink,spaceCanonicalUrl,spaceDeepLink,workstreamCanonicalUrl,
workstreamDeepLink,
workstreamDeepLinkFromParsedTarget,
type ParsedWorkstreamLinkTarget,type SidekickLinkTarget,type SpaceLinkTarget,
type WorkstreamLinkTarget
} from "./workstream-links";
export { uuidFromBase58, uuidToBase58 } from "./uuid-base58";

export const TimestampSchema = z.string().datetime({ offset: true });

/**
 * Branded identifiers.
 *
 * Every id in this system is a UUID string, which means the type system sees a
 * workspace id, a work-stream id, and a run id as interchangeable — and the
 * places they meet are exactly the places a swap is catastrophic: a Durable
 * Object *name* built from them addresses a different object, silently, with
 * no error on either side. The brands make provenance part of the type: a
 * value is a `WorkspaceId` because it was parsed from a schema that says so,
 * or because a boundary explicitly cast it with `asWorkspaceId` where the
 * database column or route parameter is the authority on what it is.
 *
 * The casts validate (they parse), so a brand is never a lie about shape —
 * only the boundary's claim about meaning, made in one greppable place
 * instead of implicitly everywhere.
 */
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export type WorkstreamId = z.infer<typeof WorkstreamIdSchema>;
export type HarnessRunId = z.infer<typeof HarnessRunIdSchema>;
export type UserId = z.infer<typeof UserIdSchema>;
export type SubstreamId = z.infer<typeof SubstreamIdSchema>;
export const ScopeSchema = z.enum(["personal", "workspace"]);
export const HarnessFailureCodeSchema = z.enum([
  "run_wall_time_limit_exceeded",
  "run_iteration_limit_exceeded",
  "run_tool_call_limit_exceeded",
  "run_cost_limit_exceeded",
  "harness_execution_failed",
  // Avalon could not durably record a tool's execution receipt. Separate from
  // the catch-all because a write may already have crossed its external
  // boundary and must not be repeated blindly.
  "tool_receipt_persistence_failed",
  // The run's own liveness, progress, activation, or inference ledger could
  // not be persisted. This is an Avalon recovery problem, not a provider fault.
  "run_state_persistence_failed",
  "context_limit_exceeded",
  // The endpoint refused the prompt as longer than it accepts. Distinct from
  // `context_limit_exceeded`, which is Rally's own accounting saying a run
  // cannot be made to fit: this one is Rally believing it fits and the
  // endpoint disagreeing, which is the only way the two can be told apart and
  // is the difference between a compaction defect and a window Rally has
  // wrong. The deployment's limit is the authority and it is not always the
  // catalog's: a run died on 2026-09-17 sized from OpenRouter's 1,050,000-token
  // figure against an Azure deployment that accepts 922,000, and the request
  // error came back as `harness_execution_failed` — Rally's own defect, no
  // remedy, "copy the request ID for support" — when the reason was in the 400
  // body the whole time. The name is the endpoint's own machine code so an
  // operator grepping what the provider said finds the run that got it.
  "context_length_exceeded",
  // No endpoint for the model accepts an input the request carries (an image,
  // a file, audio), as OpenRouter's `failed_routing_step` names it.
  "model_input_unsupported",
  "tool_surface_too_large",
  "ambiguous_external_write",
  // Every route candidate answered with a transport fault the provider owns —
  // no response, a 408/429, or a 5xx. Distinct from `harness_execution_failed`
  // because the two send a reader to different places: this one is the
  // provider's outage and is worth retrying, that one is Avalon's own defect
  // and is not. Collapsing them cost an investigation once already; see
  // `docs/agent-harness.md`.
  "provider_unavailable",
  // Avalon declined to call the endpoint at all: its circuit breaker had already
  // opened, so the run was refused before a request went out. Separate from
  // `provider_unavailable` because the breaker also opens on 401/402/403, which
  // are Avalon's credential and credit rather than the provider's health — and
  // naming those as the provider's is exactly what the sibling code forbids.
  // The member-facing remedy is the same for both; the codes differ so an
  // operator can tell "we tried and got nothing" from "we did not try".
  "provider_circuit_open",
  // The platform refused the call, not the thing being called. Cloudflare caps
  // how deep a request may recurse through Workers and how many subrequests one
  // invocation may make, and answers both with a refusal that arrives at
  // whichever port happened to ask next — a D1 read, a Durable Object hop, a
  // fetch. Filing that under the port's own code sends a reader to the storage
  // layer for a fault that storage never saw: on 2026-08-24 a work stream died
  // reporting `tool_receipt_persistence_failed` when nothing about the receipt
  // had failed. Same reasoning as the two provider arms above — the code exists
  // so the failure names the system that produced it.
  "platform_limit_exceeded"
]);
export type HarnessFailureCode = z.infer<typeof HarnessFailureCodeSchema>;

/**
 * The OpenRouter models a creator may pin a work stream to from the composer's
 * developer-mode model selector, in the order the selector lists them.
 *
 * **Each vendor's models are ordered newest first.** The selector groups by
 * vendor, so that ordering is what a reader sees under each heading, and the
 * model somebody is most likely to want is the one they do not have to scan
 * for. A new model therefore goes at the *top* of its family rather than the
 * end of the list. The "orders each vendor's models newest first" test holds
 * the half of this a machine can check — a family whose ids carry comparable
 * version numbers must not ascend — which is every family except the two whose
 * members share a version (`claude-*-5.5`, `deepseek-v4.1-*`) and are ordered
 * by hand.
 *
 * Nothing reads position 0. An earlier note here claimed the first entry was
 * what the selector showed before anything was chosen, and that has not been
 * true since the unpinned state became a row of its own: the menu renders
 * `UNPINNED_AGENT_MODEL` above every group and labels it **Default**, on the
 * reasoning in `agent-models.ts` that the renderer cannot see which variation
 * `agent-model-workstream` served and so must not name a model for it.
 *
 * This is a *closed* list rather than a free-text model id on purpose: an
 * override bypasses the Flagship rollout for the work stream it is attached to,
 * so the set of models that can be reached that way is a product decision
 * reviewed here rather than whatever string a client sends. Removing a model
 * from it stops new overrides naming it; work streams already pinned to it fall
 * back to the flag, because the API re-validates the stored value on read.
 *
 * See `docs/feature-flags.md` for how an override composes with the flags.
 */
export const AGENT_MODEL_OVERRIDES = [
  "x-ai/grok-4.7",
  "x-ai/grok-4.6",
  "x-ai/grok-4.5",
  "google/gemini-4-argon",
  "google/gemini-3.8-flash",
  "google/gemini-3.7-flash",
  "openai/gpt-6.1-sol",
  "openai/gpt-6-luna",
  "openai/gpt-5.6-sol",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-sonnet-5.5",
  "deepseek/deepseek-v4.1-flash-1017",
  "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4-pro",
] as const;
export const AgentModelOverrideSchema = z.enum(AGENT_MODEL_OVERRIDES);
export type AgentModelOverride = z.infer<typeof AgentModelOverrideSchema>;

/** Every distinct model-using Rally task whose route is controlled by Flagship. */
export const AGENT_MODEL_ROLES = [
  "workstream",
  "inline_child",
  "workstream_naming",
  "work_opportunity_admission",
  "work_opportunity_ranking",
  "workstream_description",
  "session_import",
  "suggestion_draft",
  "memory_sweep",
] as const;
export type AgentModelRole = (typeof AGENT_MODEL_ROLES)[number];

/** Flagship flag key per model-using task. */
export const AGENT_MODEL_FLAG_KEYS: Readonly<Record<AgentModelRole, string>> = {
  workstream: "agent-model-workstream",
  inline_child: "agent-model-inline-child",
  workstream_naming: "agent-model-workstream-naming",
  work_opportunity_admission: "agent-model-work-opportunity-admission",
  work_opportunity_ranking: "agent-model-work-opportunity-ranking",
  workstream_description: "agent-model-workstream-description",
  session_import: "agent-model-session-import",
  suggestion_draft: "agent-model-suggestion-draft",
  memory_sweep: "agent-model-memory-sweep",
};

/** One task's primary OpenRouter model and its ordered fallback route. */
export const AgentModelRoutingSchema = z.object({
  model: z.string().trim().min(1),
  // Older or manually-authored Flagship values may omit the array. Treating
  // that shape as no fallbacks keeps every evaluator and operator surface in
  // agreement instead of silently substituting a different checked-in route.
  fallbackModels: z.array(z.string().trim().min(1)).default([]),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
});
export type AgentModelRouting = z.infer<typeof AgentModelRoutingSchema>;

export const MemberRoleSchema = z.enum(["owner", "admin", "member"]);
/**
 * The roles an administrator may hand to somebody else.
 *
 * One schema for both ways a role is assigned — the role carried on an
 * invitation, and the role set on a membership that already exists — because
 * they are the same decision made at two moments, and a second enum is how the
 * two drift. `owner` is deliberately not in it: the founding membership is the
 * one role nobody may grant, and transferring it is a different operation
 * nobody has asked for.
 */
export const AssignableMemberRoleSchema = z.enum(["admin", "member"]);
export const IanaTimezoneSchema = z.string().trim().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "Timezone must be a supported IANA timezone");

export const UserSchema = z.object({
  presentation: PersonalPresentationSchema.nullable().optional(),
  id: IdSchema,
  email: z.string().email(),
  name: z.string().min(1),
  avatarUrl: HttpUrlSchema.nullable(),
  timezone: IanaTimezoneSchema,
  createdAt: TimestampSchema
});

export const WorkspaceSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(120),
  slug: z.string().min(2).max(80),
  region: RegionSchema,
  // Absent accessClass is the legacy full-member wire representation.
  accessClass: z.enum(["member", "guest"]).optional(),
  role: MemberRoleSchema.nullable(),
  timezone: IanaTimezoneSchema,
  createdAt: TimestampSchema
}).refine((workspace) => workspace.accessClass === "guest"
  ? workspace.role === null : workspace.role !== null,
{ message: "Guests have no workspace role; members require a role" });

export const WorkspaceMemberSchema = z.object({
  user: UserSchema,
  incarnation: z.string().min(1).optional(),
  revision: z.number().int().positive().optional(),
  accessClass: z.enum(["member", "guest"]).optional(),
  role: MemberRoleSchema.nullable(),
  status: z.enum(["active", "invited", "suspended"]),
  joinedAt: TimestampSchema.nullable()
}).refine((member) => member.accessClass === "guest" ? member.role === null : member.role !== null,
{ message: "Guests have no workspace role; members require a role" });

export const WorkspaceInvitationRoleSchema = AssignableMemberRoleSchema;
/** Set the role of a membership that already exists. */
export const UpdateWorkspaceMemberRoleRequestSchema = z.object({
  role: AssignableMemberRoleSchema
});
export const WorkspaceInvitationStatusSchema = z.enum(["pending", "accepted", "expired", "revoked"]);
export const WorkspaceInvitationSchema = z.object({
  id: IdSchema,
  email: z.string().email(),
  role: WorkspaceInvitationRoleSchema,
  status: WorkspaceInvitationStatusSchema,
  invitedByName: z.string().min(1),
  expiresAt: TimestampSchema,
  acceptedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema
});
/**
 * Someone invited to the Organization who has not accepted yet, as every
 * member may see them: the address and when it was invited, nothing an
 * administrator manages. They have no account here until they sign in, so the
 * address is the only way to name them; pickers offer them beside members so
 * a teammate can be brought into a Channel before they arrive.
 */
export const WorkspaceInviteeSchema = z.object({
  email: z.string().email(),
  invitedAt: TimestampSchema
});
export const WorkspaceInvitationPreviewSchema = z.object({
  workspaceId: IdSchema,
  workspaceName: z.string().min(1).max(120),
  region: RegionSchema,
  email: z.string().email(),
  role: WorkspaceInvitationRoleSchema,
  expiresAt: TimestampSchema
});
export const PendingWorkspaceInvitationSchema = WorkspaceInvitationPreviewSchema.extend({
  id: IdSchema,
  invitedByName: z.string().min(1)
});
export const WorkspaceOnboardingStateSchema = z.object({
  workspace: WorkspaceSchema.nullable().default(null),
  workspaces: z.array(WorkspaceSchema).optional(),
  invitations: z.array(PendingWorkspaceInvitationSchema)
}).transform((value) => ({
  workspace: value.workspace,
  workspaces: value.workspaces ?? (value.workspace ? [value.workspace] : []),
  invitations: value.invitations,
}));
/** An Organization's display name, as chosen at creation and on every rename. */
export const WorkspaceNameSchema = z.string().trim().min(2).max(120);
/** A name to prefill when creating an organization; null when there is none to offer. */
export const OrganizationNameSuggestionSchema = z.object({ name: WorkspaceNameSchema.nullable() });
export type OrganizationNameSuggestion = z.infer<typeof OrganizationNameSuggestionSchema>;
export const CreateWorkspaceRequestSchema = z.object({
  name: WorkspaceNameSchema,
  region: ConfiguredRegionSchema
});
export const OnboardingRegionRequestSchema = z.object({ region: ConfiguredRegionSchema });
export const ActivateWorkspaceRequestSchema = OnboardingRegionRequestSchema.extend({
  workspaceId: IdSchema
});
export const CreateWorkspaceInvitationRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  role: WorkspaceInvitationRoleSchema.default("member")
});
export const CreateWorkspaceInvitationResponseSchema = z.object({
  invitation: WorkspaceInvitationSchema,
  inviteUrl: HttpUrlSchema,
  emailDelivery: z.enum(["sent", "skipped"])
});
export const AcceptWorkspaceInvitationRequestSchema = z.object({
  token: z.string().min(20).max(500)
});
export const WorkspaceDepartureOutcomeSchema = z.enum(["left", "abandoned"]);
export const WorkspaceDepartureRequestSchema = z.object({
  expectedOutcome: WorkspaceDepartureOutcomeSchema,
});
export const WorkspaceDepartureSchema = z.object({
  outcome: WorkspaceDepartureOutcomeSchema,
});
export const WorkspaceAttentionSchema = z.object({
  waitingForYou: z.number().int().nonnegative(),
  waitingReason: z.enum(["mentioned", "needs_input", "unseen"]).nullable(),
  hasUnreadActivity: z.boolean(),
  /**
   * Conversations (each Main and each Breakout) unread, unseen or mentioning
   * this person: the sidebar attention menu's count, and the dock badge.
   */
  readerAttentionCount: z.number().int().nonnegative().default(0),
});

/**
 * Every server-decided feature flag a client is allowed to see, resolved for
 * the signed-in person. Each field defaults to the answer an unreachable flag
 * provider — or a response from an older service that does not know the field —
 * has to reproduce. That answer is not the same shape for every field:
 * **off** for a feature nobody has been given yet, **on** for a feature that is
 * already on for everyone and whose flag exists only to turn it off, and
 * today's checked-in behavior for a setting that has no off at all.
 */
export const ClientFeatureFlagsSchema = z.object({
  /** Whether Application → Developer may be offered on this device. */
  developerSettings: z.boolean().default(false),
  /** Whether Suggested Work surfaces are shown in Electron for this person. */
  suggestedWorkEnabled: z.boolean().default(false),
  /** Whether Electron offers workspace switching and plural workspace setup. */
  multipleWorkspacesEnabled: z.boolean().default(false),
  /**
   * Whether live-artifact surfaces are shown in Electron for this person.
   *
   * Presentation only, and that distinction is load-bearing: it gates the
   * rail's site detail, the preview pane, the Data view, and the artifact
   * window. Nothing that protects an artifact's data is scoped by it —
   * authorization is structural, so a URL somebody already holds keeps working
   * through its session checks whether or not this is on.
   */
  liveArtifactsEnabled: z.boolean().default(false),
  pushNotificationsEnabled: z.boolean().default(false),
});

/** Product flags Ace is allowed to manage and publish to connected clients. */
export const ProductFeatureFlagKeySchema = z.enum([
  "suggested-work-enabled",
  "multiple-workspaces-enabled",
  "push-notifications-enabled",
  "live-artifacts-enabled",
]);
export const ProductFeatureFlagFanoutMessageSchema = z.strictObject({
  kind: z.literal("product_feature_flag_changed"),
  flagKey: ProductFeatureFlagKeySchema,
  workspaceId: IdSchema,
});

export const ParticipantSchema = z.object({
  user: UserSchema,
  participationReason: z.enum(["creator", "explicit", "message", "elicitation", "action"]),
  joinedAt: TimestampSchema
});

export const ViewerSchema = z.object({
  user: UserSchema,
  connectedAt: TimestampSchema
});

/** The most prompt text a compact work-stream wake-up marker may expose. */
export const WORKSTREAM_WAKEUP_PROMPT_PREVIEW_LENGTH = 40;

/**
 * The most faces a sidebar work-stream row paints before the overflow circle.
 *
 * The directory carries only this many participant ids per personal row, newest
 * overlay first; `participantExtraCount` is everyone past the cap. Raising it
 * is a product decision, not a layout tweak — the sidebar's dense row is what
 * the number was sized for.
 */
export const WORKSTREAM_SIDEBAR_FACEPILE_LIMIT = 3;

/** Cap a recency-sorted participant id list for the sidebar facepile. */
export function workstreamParticipantPreview(userIds: readonly string[]): {
  participantUserIds: string[];
  participantExtraCount: number;
} {
  return {
    participantUserIds: userIds.slice(0, WORKSTREAM_SIDEBAR_FACEPILE_LIMIT),
    participantExtraCount: Math.max(0, userIds.length - WORKSTREAM_SIDEBAR_FACEPILE_LIMIT),
  };
}

export { MESSAGE_MAX_CHARACTERS,MESSAGE_TOO_LONG_MESSAGE } from "./message-limits";

/**
 * The most text a work stream's description may carry.
 *
 * Deliberately far below {@link MESSAGE_MAX_CHARACTERS}, because a description
 * is not a message: it is the line the sidebar shows under the title, the text
 * the routing classifier reads, and the standing context every run starts from
 * (see `docs/workstream-descriptions.md`). It is also stored in every workspace
 * directory row and pushed to every client on connect, so its size is paid on
 * reads that have nothing to do with the work stream it describes.
 *
 * Changing this number means changing the `length(description) <= 4000` CHECK on
 * `channels` and the producer-side bound in
 * `workstream-regional-effect.ts` in the same breath, or a description this
 * accepts commits into an outbox whose delivery can never succeed.
 */
export const WORKSTREAM_DESCRIPTION_MAX_CHARACTERS = 4_000;

/**
 * One breakout its viewer may open, as the Channel's rail draws it. Only ready,
 * unarchived breakouts with that viewer on their roster are listed.
 */
export const WorkstreamPrivateChildSchema = z.strictObject({
  /** Done, independently of whether it is archived or an agent run is active. */
  resolved: z.boolean().optional(),
  substreamId: SubstreamIdSchema.refine((value) => value !== "0", "A private child must be nonzero"),
  title: z.string().min(1).max(500),
  appearance: WorkstreamAppearanceSchema.optional(),
  harnessStatus: HarnessStatusSchema.optional(),
  unreadCount: z.number().int().nonnegative().optional(),
  youAreMentioned: z.boolean().optional(),
  unseen: z.boolean().optional(),
  createdByUserId: UserIdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** The Main transcript turn the breakout was branched through; null when it was not branched from a turn. */
  originTurnId: z.string().min(1).nullable().optional(),
  /** When the breakout last had activity; absent until its directory state has arrived. */
  lastActivityAt: TimestampSchema.optional(),
});

/**
 * Running background agents by the conversation they work for, keyed by
 * substream id. A conversation with none is absent.
 */
export const WorkstreamBackgroundAgentCountsSchema = z.record(SubstreamIdSchema, z.number().int().positive());

export const WorkstreamSchema = z.object({
  /** Done, independently of archiving and the current agent run. */
  resolved: z.boolean().optional(),
  appearance: WorkstreamAppearanceSchema.optional(),
  id: IdSchema,
  workspaceId: IdSchema,
  title: z.string().min(1).max(180),
  /**
   * Who owns the title. `naming` means Avalon is still choosing one and the
   * stored title is a placeholder, so a surface that shows it renders a
   * skeleton; `automatic` means Avalon named it and one later pass may replace
   * it; `settled` means it will not change on its own again.
   */
  titleStatus: z.enum(["naming", "automatic", "settled"]).default("settled"),
  objective: z.string().max(WORKSTREAM_DESCRIPTION_MAX_CHARACTERS),
  /** Stable inbound address. Null is transitional for pre-migration rows only. */
  emailAddress: z.string().email().max(254).nullable().default(null),
  createdByUserId: IdSchema.nullable(),
  harnessStatus: HarnessStatusSchema,
  latestAttentionSequenceNumber: z.number().int().nonnegative(),
  readThroughSequenceNumber: z.number().int().nonnegative(),
  manualUnreadFromSequenceNumber: z.number().int().nonnegative().nullable(),
  manualUnreadGeneration: z.number().int().nonnegative(),
  hasUnread: z.boolean(),
  /** True while a person mention sits above this viewer's seen waterline. */
  youAreMentioned: z.boolean().default(false),
  /**
   * True while this person has been put in the work stream and has not opened
   * it once. A different question from `hasUnread`, which is about messages
   * arriving in a room somebody already knows: this says the room itself is
   * new to them, which is the state somebody added by a colleague wakes up in
   * and the one that survives a work stream whose transcript they have no
   * reason to have read. Cleared by the first open, and never set again.
   *
   * Defaulted because a payload written before this field existed describes a
   * work stream whose readers have all had it for a while.
   */
  unseen: z.boolean().default(false),
  /**
   * Whether this viewer takes part in Main, which is what puts it in their
   * Threads list. A workspace-scoped row is listed to everyone, so its unread
   * is no sign it waits on this viewer; the attention count reads this to
   * count only threads the Threads list shows. Absent means not said (an
   * older server or a child-owned response).
   */
  isParticipant: z.boolean().optional(),
  firstUnreadSequenceNumber: z.number().int().nonnegative().nullable(),
  lastActivityAt: TimestampSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  archivedAt: TimestampSchema.nullable(),
  /**
   * Who may read it, in the same vocabulary `notes` uses: `personal` is only the
   * people in it, `workspace` is anyone in the workspace. Declared on the row
   * and enforced from it, so "private" is a property rather than a rule a caller
   * has to remember. A work stream is born `personal` and is opened by somebody
   * in it, so the default here is the fail-closed one: a payload that somehow
   * carries no scope is read as the narrower of the two rather than announced
   * to the workspace.
   */
  scope: ScopeSchema.default("personal"),
  /**
   * Non-null on a work stream that exists so a subsystem can use the agent loop
   * rather than because somebody started it. A separate question from `scope`:
   * this decides whether it is *listed*, that decides who may read it. Listing
   * surfaces leave these out unless the reader has asked to see them, and render
   * them as secondary when they do.
   */
  systemKind: z.enum(["digest"]).nullable().default(null),
  /**
   * The model this conversation is pinned to, ahead of `agent-model-workstream`,
   * or null for the ordinary unpinned case. Decided once at creation and fixed
   * for the conversation's life.
   *
   * Per conversation, not per work stream: a substream is a separate object with
   * a column of its own, is pinned by being created pinned, and inherits
   * nothing from its parent. `docs/feature-flags.md` owns the rule.
   *
   * On the wire so the composer's model pill can name the model a *pinned*
   * conversation will run on even when no run has recorded one yet — a run that
   * failed before its first token leaves `harness_runs.model` null, and a pill
   * that answered **Default** there would be stating something false about a
   * conversation that never consults the flag.
   *
   * Re-validated against the closed set on the way out, so a model retired from
   * `AGENT_MODEL_OVERRIDES` reads as null here exactly as it resolves on the
   * server: back to the flag.
   */
  modelOverride: AgentModelOverrideSchema.nullable().default(null),
  /** The first one-shot wake-up still waiting to fire, if there is one. */
  nextPendingWakeup: z.object({
    dueAt: TimestampSchema,
    promptPreview: z.string().min(1).max(WORKSTREAM_WAKEUP_PROMPT_PREVIEW_LENGTH + 1),
  }).nullable().default(null),
  /** Retired workspace-wide pin position. New servers always return `null`. */
  pinPosition: z.number().int().nonnegative().nullable().default(null),
  /**
   * This viewer's pin positions for this Channel, one per Space placement.
   * A Channel in several Spaces can be pinned independently in any subset of
   * them; each position is meaningful only among pins carrying the same
   * `spaceId`.
   */
  spacePins: z.array(z.strictObject({
    spaceId: SpaceIdSchema,
    position: z.number().int().nonnegative(),
  })).superRefine((pins, context) => {
    const seen = new Set<string>();
    pins.forEach((pin, index) => {
      if (seen.has(pin.spaceId)) context.addIssue({
        code: "custom",
        path: [index, "spaceId"],
        message: "Space pin ids must be unique",
      });
      seen.add(pin.spaceId);
    });
  }).default([]),
  /** Workspace-owned visit time; omitted by older servers and child-owned responses. */
  lastAccessedAt: TimestampSchema.nullable().optional(),
  /**
   * People in a personal work stream, for the sidebar facepile. At most
   * {@link WORKSTREAM_SIDEBAR_FACEPILE_LIMIT} ids, newest first, with
   * `participantExtraCount` for everyone past that. Empty on a workspace-scoped
   * row: that surface paints a public marker rather than a pile, and the
   * directory must not carry what it does not paint.
   *
   * Defaulted because a payload written before this field existed is a row
   * whose sidebar showed a lock instead.
   */
  participantUserIds: z.array(IdSchema).max(WORKSTREAM_SIDEBAR_FACEPILE_LIMIT).default([]),
  participantExtraCount: z.number().int().nonnegative().default(0),
  /**
   * Every Space this Channel currently sits in.
   *
   * A Channel belongs to at least one Space and may belong to several; each is
   * a *placement* of this same row rather than a copy of it, so a sidebar
   * renders one entry per id and all of them open the same Channel.
   *
   * Uncapped, deliberately. The ids are the Channel's own memberships rather
   * than a fan-out over the Organization — a Channel is in as many Spaces as
   * somebody put it in — and truncating the list would make a placement
   * disappear from one of the Spaces that actually holds it.
   *
   * Defaulted because a payload written before Spaces existed describes a
   * Channel from the flat directory they replace.
   */
  spaceIds: z.array(SpaceIdSchema)
    .refine((ids) => new Set(ids).size === ids.length, "Space ids must be unique")
    .default([]),
  /** Breakouts under this Channel that currently need this viewer. */
  breakoutAttentionCount: z.number().int().nonnegative().optional(),
  /**
   * Set when this viewer is listed the Channel only through a Breakout, so
   * Main is not theirs to open and the row's Main fields are emptied
   * (`docs/listing-rules.md`). Absent means Main is this viewer's.
   */
  mainWithheld: z.literal(true).optional(),
  /**
   * The breakouts this viewer may open, on workspace-socket rows only.
   *
   * This and the two fields below are what the Channel control socket added to
   * the directory row. They ride the row so one socket carries a Channel's
   * whole state. Absent means this row does not say (a REST answer, an older
   * server, or a Channel whose parent has not been imported yet), never that
   * the list is empty.
   */
  privateChildren: z.array(WorkstreamPrivateChildSchema).optional(),
  /**
   * Orders `privateChildren` for this viewer. Independent of the row's state
   * version: the list moves with breakout rosters, which do not advance it.
   */
  privateChildrenWaterline: z.number().int().nonnegative().optional(),
  /** See {@link WorkstreamBackgroundAgentCountsSchema}; workspace-socket rows only. */
  backgroundAgentCounts: WorkstreamBackgroundAgentCountsSchema.optional(),
  /**
   * Advances whenever this Channel's rail data (participants, Sidekicks,
   * Channel resources) changes; a client holding an older rail asks again
   * with `channel_rails`. Workspace-socket rows only; absent means not said.
   */
  railWaterline: z.number().int().nonnegative().optional(),
});

export const ExternalActorSchema = z.object({
  provider: z.string().min(1).max(80),
  providerAccountId: z.string().min(1).max(200),
  providerUserId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(180),
  avatarUrl: HttpUrlSchema.nullable(),
});

export const MessageAuthorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("human"), user: UserSchema }),
  z.object({ type: z.literal("external"), actor: ExternalActorSchema }),
  z.object({ type: z.literal("agent") }),
  z.object({ type: z.literal("system") })
]);


export const MessageAttachmentSchema = z.object({
  id: IdSchema,
  fileName: z.string().min(1).max(300),
  mimeType: z.string().min(1).max(160),
  sizeBytes: z.number().int().nonnegative(),
  contentAvailable: z.boolean(),
  createdAt: TimestampSchema,
});

export const MessageSchema = z.object({
  id: TranscriptTurnIdSchema,
  clientMessageId: z.string().max(120).nullable(),
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  author: MessageAuthorSchema,
  messageType: z.enum(["text", "system", "tool", "elicitation", "suggestion", "automation_activation"]),
  textContent: z.string(),
  structuredContent: z.record(z.string(), z.unknown()).nullable(),
  mentions: z.array(MentionSchema),
  attachments: z.array(MessageAttachmentSchema).default([]),
  sequenceNumber: z.number().int().nonnegative(),
  attentionSequenceNumber: z.number().int().positive().nullable().optional(),
  createdAt: TimestampSchema,
  editedAt: TimestampSchema.nullable()
});

export const ResourceSchema = z.object({
  id: IdSchema,
  slug: ResourceSlugSchema.nullable().default(null),
  workspaceId: IdSchema,
  connectionId: IdSchema.nullable(),
  resourceType: z.string().min(1).max(80),
  provider: z.string().min(1).max(80),
  providerResourceId: z.string().max(500).nullable(),
  title: z.string().min(1).max(300),
  mimeType: z.string().max(160).nullable(),
  canonicalUrl: HttpUrlSchema.nullable(),
  refreshSupported: z.boolean().default(false),
  watchEnabled: z.boolean(),
  watchStatus: z.enum(["watching", "paused", "unsupported", "error"]),
  lastHydratedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  contentAvailable: z.boolean().default(false),
  sizeBytes: z.number().int().nonnegative().default(0),
  currentVersion: z.number().int().positive().default(1),
});

export const WorkstreamResourceSchema = ResourceSchema.extend({
  // The live storage vocabulary excludes `suggested_activity`. This wire-only
  // parser admits the previous Worker's accepted-resource snapshots long
  // enough for a newer desktop to normalize them to ordinary attachments.
  relationshipType: WireResourceRelationshipTypeSchema,
  direction: ResourceDirectionSchema,
});

/**
 * Who moved a resource's pointers into the state a version holds.
 *
 * One shape per kind rather than a kind plus a shared identifier: a run, a
 * member and a connection are all UUIDs, and the surfaces that render
 * attribution resolve them against different authorities.
 */
export const ResourceVersionAuthorSchema = z.discriminatedUnion("kind", [
  // Strict, like the attachment shapes: the union's whole claim is one
  // identity per kind, and a non-strict variant would quietly accept — and
  // then drop — an identity belonging to another one.
  z.strictObject({ kind: z.literal("agent"), runId: IdSchema }),
  z.strictObject({ kind: z.literal("member"), userId: IdSchema }),
  z.strictObject({ kind: z.literal("connector"), connectionId: IdSchema }),
  z.strictObject({ kind: z.literal("system") }),
]);

/** Why the pointers moved. `created` is a resource's own first state. */
export const ResourceVersionCauseSchema = z.enum(["created", "published", "refetched", "replaced", "renamed"]);

export const ResourceRevisionSchema = z.object({
  resourceId: IdSchema,
  version: z.number().int().positive(),
  /**
   * Null where history predates provenance, or a producer records none. The
   * surfaces say a version is unattributed rather than inventing an author.
   */
  author: ResourceVersionAuthorSchema.nullable(),
  /**
   * A cause this client does not know reads as none, so a later cause leaves
   * the history listable rather than failing the whole response, as
   * `renamed` does for a desktop build from before it.
   */
  cause: ResourceVersionCauseSchema.nullable().catch(null),
  /**
   * What kind of thing the version's refs name — an immutable object in the
   * region's bucket for everything written so far. Deliberately not an enum:
   * a later storage shape joins this history by writing a new value, and a
   * client that does not know the value still lists and opens the version.
   */
  storageKind: z.string().min(1).max(40),
  title: z.string().min(1).max(300),
  resourceType: z.string().min(1).max(80),
  provider: z.string().min(1).max(80),
  providerResourceId: z.string().max(500).nullable(),
  mimeType: z.string().max(160).nullable(),
  canonicalUrl: HttpUrlSchema.nullable(),
  lastHydratedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  contentAvailable: z.boolean(),
  modelContentAvailable: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
});

// Every run is always delivered to its Avalon work stream. These are the
// additional destinations a personal automation freezes when it is saved.
export const AutomationDeliveryTargetTypeSchema = z.enum(["slack_agent_dm", "email"]);

export const ConnectionToolCountSchema = z.object({
  count: z.number().int().nonnegative(),
});

export const ConnectionSchema = z.object({
  id: IdSchema,
  modelPluginId: z.string().regex(/^plugin_[a-z][a-z0-9_]{0,62}$/u),
  workspaceId: IdSchema,
  connectorType: z.enum(["apollo", "ashby", "canva", "custom_mcp", "fireflies", "google", "generic_webhook", "github", "granola", "linear", "notion", "slack", "x"]),
  scope: ScopeSchema,
  ownerUserId: IdSchema.nullable(),
  ownerName: z.string().nullable(),
  displayName: z.string().min(1).max(180),
  grantedCapabilities: z.array(z.string()),
  status: z.enum(["healthy", "needs_reconnect", "error", "disabled"]),
  settingsKind: z.enum(["github_repository_access", "custom_mcp_tools"]).nullable().default(null),
  /**
   * Set when this connection can deliver automation results to the requesting
   * user right now — the connector declares the surface and, where the
   * installation is workspace-wide, that user has linked their own identity to
   * it. Null means the connection is not a personal destination.
   */
  userDelivery: z.object({
    targetType: AutomationDeliveryTargetTypeSchema,
    label: z.string().min(1).max(80),
    description: z.string().min(1).max(240),
  }).nullable().default(null),
  /**
   * How many agent tools this connection exposes, so Settings can draw the
   * Tools column from this one response rather than one request per row.
   *
   * A connector with a fixed tool surface is counted from its catalog and
   * grants, with the page tools activation generates beside a paginated one.
   * One whose tools come from live provider discovery reports the count its
   * last successful discovery found. Null means there is no count to show, and
   * `toolCountMissing` says why; it is never a stand-in for zero. Defaults to
   * null so a region that does not send it yet still parses.
   */
  toolCount: z.number().int().nonnegative().nullable().default(null),
  /**
   * Why `toolCount` is null, so Settings can say so rather than draw a bare
   * dash: `disabled`; `connector_unavailable` (this region does not register
   * the connector); `counting` (this list just started the connection's one
   * background discovery); `not_counted` (a discovered connection whose last
   * discovery failed, or has not finished). Null whenever there is a count,
   * and from a region that predates the field.
   */
  toolCountMissing: z.enum(["disabled", "connector_unavailable", "counting", "not_counted"]).nullable().default(null),
  lastSyncAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema
});

export const ConnectorInstallationReadResponseSchema = z.object({ installation: ConnectorInstallationSchema.nullable() });
export const ConnectorInstallationMutationResponseSchema = z.object({ installation: ConnectorInstallationSchema });
/**
 * What an administrator has to carry to a provider that offers no registration
 * API, returned exactly once by the setup call that generated it.
 *
 * The signing secret is the deliberate exception to "a secret never reaches the
 * desktop": a manual registration cannot be completed without the plaintext,
 * and Rally is the side that generates it. It is absent from `GET /connections`,
 * from the installation document, from display names, and from audit data, and a
 * replayed setup returns `null` rather than re-revealing it — a lost secret is
 * replaced by reconnecting, not by asking again.
 */
export const ConnectorManualRegistrationSchema = z.strictObject({
  destination: HttpsUrlSchema,
  signingSecret: z.string().min(1).max(512),
});
export type ConnectorManualRegistration = z.infer<typeof ConnectorManualRegistrationSchema>;
export const ConnectorInstallationSetupResponseSchema = z.object({
  installation: ConnectorInstallationSchema,
  connection: ConnectionSchema,
  manualRegistration: ConnectorManualRegistrationSchema.nullable().default(null),
});
export const ConnectionTestResponseSchema = z.object({ ok: z.boolean(), message: z.string(), reconnectRequired: z.boolean().optional() });

export const GitHubRepositoryRemoteAccessSchema = z.enum(["read_only", "full_access"]);
export const GitHubRepositoryAccessModeSchema = z.enum(["all_repositories", "selected_repositories"]);
export const GitHubRepositoryAccessEntrySchema = z.strictObject({
  repositoryId: z.string().min(1).max(100),
  repositoryFullName: z.string().regex(/^[^/\s]{1,100}\/[^/\s]{1,100}$/u),
  remoteAccess: GitHubRepositoryRemoteAccessSchema,
});
export const GitHubRepositoryAccessSettingsSchema = z.strictObject({
  connectionId: IdSchema,
  connectionName: z.string().min(1).max(180),
  revision: z.number().int().nonnegative(),
  mode: GitHubRepositoryAccessModeSchema,
  defaultRemoteAccess: GitHubRepositoryRemoteAccessSchema,
  repositories: z.array(GitHubRepositoryAccessEntrySchema).max(1_000),
  availableRepositories: z.array(z.strictObject({
    repositoryId: z.string().min(1).max(100),
    repositoryFullName: z.string().regex(/^[^/\s]{1,100}\/[^/\s]{1,100}$/u),
    private: z.boolean(),
    remoteAccess: GitHubRepositoryRemoteAccessSchema.nullable(),
  })).max(1_000),
});
export const UpdateGitHubRepositoryAccessSettingsSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  mode: GitHubRepositoryAccessModeSchema,
  defaultRemoteAccess: GitHubRepositoryRemoteAccessSchema,
  repositories: z.array(GitHubRepositoryAccessEntrySchema).max(1_000),
});

export const ActivitySourcePluginIdsSchema = z.record(ActivitySourceBindingKeySchema, ModelPluginIdSchema);
export const AutomationPluginIconSchema = z.enum([
  "brand-github",
  "brand-google",
  "brand-google-drive",
  "brand-notion",
  "brand-slack",
  "linear",
  "plug",
  "webhook",
  "world-search",
]);
export type AutomationPluginIcon = z.infer<typeof AutomationPluginIconSchema>;

export const AutomationPluginActivitySchema = z.object({
  canonicalId: z.string().min(1).optional(),
  connectorType: z.string().optional(),
  pluginId: ModelPluginIdSchema,
  displayName: z.string().min(1).max(200),
  icon: AutomationPluginIconSchema,
});
export type AutomationPluginActivity = z.infer<typeof AutomationPluginActivitySchema>;

export const AutomationPluginRecommendationSchema = z.object({
  pluginId: ModelPluginIdSchema,
  recommendedTools: z.array(z.string().min(1).max(160)).max(40).default([]),
  reason: z.string().min(1).max(800),
});

export const MemoryTableColumnTypeSchema = z.enum([
  "string",
  "url",
  "number",
  "integer",
  "boolean",
  "datetime",
  "date",
]);

export const AutomationMemoryTableColumnSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(800),
  type: MemoryTableColumnTypeSchema,
  required: z.boolean().default(false),
  searchable: z.boolean().default(false),
});

/**
 * The longest query `memory_recall` and `table_search` accept.
 *
 * It lives here because the tools declare it to the model and the services
 * enforce it, and the two must agree.
 */
export const MEMORY_RECALL_QUERY_LIMIT = 2_000;

export const AutomationMemoryTableSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1200),
  usageInstructions: z.string().trim().min(1).max(4000),
  columns: z.array(AutomationMemoryTableColumnSchema).min(1),
  keyColumns: z.array(z.string().trim().min(1).max(120)).min(1),
}).superRefine((table, context) => {
  const names = new Map<string, number>();
  table.columns.forEach((column, index) => {
    const normalized = column.name.toLocaleLowerCase();
    if (names.has(normalized)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["columns", index, "name"],
        message: "Memory-table column names must be unique",
      });
    }
    names.set(normalized, index);
  });
  const keyNames = new Set<string>();
  table.keyColumns.forEach((name, index) => {
    const normalized = name.toLocaleLowerCase();
    if (!names.has(normalized)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keyColumns", index],
        message: "Every key column must name a declared column",
      });
    }
    if (keyNames.has(normalized)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keyColumns", index],
        message: "Key columns must be unique",
      });
    }
    keyNames.add(normalized);
  });
});

export const AutomationDraftElicitationSchema = z.object({
  responseType: z.enum(["free_text", "single_select", "multi_select"]),
  prompt: z.string().min(1).max(4000),
  placeholder: z.string().max(500).nullable().default(null),
  options: z.array(z.object({
    value: z.string().min(1).max(200),
    label: z.string().min(1).max(300),
    description: z.string().max(800).nullable().default(null),
  })).max(30).default([]),
  minimumSelections: z.number().int().nonnegative().default(0),
  maximumSelections: z.number().int().positive().nullable().default(null),
  allowOther: z.boolean().default(false),
});

export const ToolInvocationSchema = z.object({
  id: IdSchema,
  harnessRunId: IdSchema,
  toolCallId: z.string().min(1).max(160),
  toolName: z.string().min(1).max(160),
  /**
   * Harness-generated prose naming what this row did. Null on rows persisted
   * before rows carried prose; those fall back to the raw tool name.
   */
  activityName: z.string().min(1).max(200).nullable().default(null),
  connectionId: IdSchema.nullable(),
  /**
   * The connector plugin that owns this tool, resolved from `connectionId`, or
   * null for Avalon-owned tools. Rows render this and only this as their icon.
   */
  plugin: AutomationPluginActivitySchema.nullable().default(null),
  status: z.enum(["pending", "started", "completed", "failed", "ambiguous"]),
  inputSummary: z.string().max(1000),
  outputSummary: z.string().max(4000).nullable(),
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable()
});

export const HarnessRunMetadataSchema = z.object({
  id: IdSchema,
  origin: z.string().min(1).max(80),
  status: z.enum(["scheduled", "running", "needs_input", "completed", "failed", "stopped"]),
  model: z.string().max(160).nullable(),
  error: z.object({
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(1200)
  }).nullable().optional(),
  requestId: z.string().min(1).max(160).nullable().optional(),
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema
});

export const BackgroundTaskSchema = z.object({
  id: IdSchema,
  harnessRunId: IdSchema,
  title: z.string().min(1).max(300),
  taskType: z.enum(["agent", "tool", "connector"]),
  status: z.enum(["running", "needs_input", "completed", "failed"]),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
  tokenCount: z.number().int().nonnegative().nullable(),
  toolUses: z.number().int().nonnegative().nullable(),
  transcriptTurnId: TranscriptTurnIdSchema.nullable()
});

export const ElicitationOptionSchema = z.object({
  value: z.string().min(1).max(200),
  label: z.string().min(1).max(300),
  description: z.string().max(800).nullable()
});
export const ElicitationSchema = z.object({
  id: IdSchema,
  workstreamId: IdSchema,
  harnessRunId: IdSchema,
  prompt: z.string().min(1).max(4000),
  responseType: z.enum(["text", "radio", "single_select", "multi_select"]),
  options: z.array(ElicitationOptionSchema),
  minimumSelections: z.number().int().nonnegative(),
  maximumSelections: z.number().int().positive().nullable(),
  targetUserId: IdSchema.nullable(),
  status: z.enum(["open", "answered", "cancelled"]),
  answer: z.union([z.string(), z.array(z.string())]).nullable(),
  answeredByUserId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  answeredAt: TimestampSchema.nullable()
});

/**
 * One conversation on a Space's dashboard: a Channel, or one of a Channel's
 * breakouts.
 *
 * Both kinds are `WorkstreamSchema` plus two fields, rather than a union,
 * because the dashboard draws them as one row type: the same status dot, the
 * same title, the same activity time, in one list ordered by activity. A union
 * would have made every one of those a branch, and the difference between the
 * kinds is two facts and a destination.
 *
 * `id` is the *conversation's* id, which is the Channel id for a Channel and
 * the substream id for a breakout. That is what makes the list keyable and the
 * cursor total; `breakoutOf` carries the addressing a breakout needs on top —
 * its parent Channel, its substream id again (checked equal to `id`, so the
 * two can never drift) and the parent's title, which the row prints so a
 * breakout is not a name with no context.
 */
export const SpaceConversationSchema = WorkstreamSchema.extend({
  kind: z.enum(["channel", "breakout"]),
  /** Non-null on exactly the breakouts. */
  breakoutOf: z.strictObject({
    workstreamId: IdSchema,
    substreamId: IdSchema,
    title: z.string().min(1).max(180),
    appearance: WorkstreamAppearanceSchema.optional(),
  }).nullable().default(null),
}).superRefine((conversation, context) => {
  if ((conversation.kind === "breakout") !== (conversation.breakoutOf !== null)) {
    context.addIssue({
      code: "custom",
      path: ["breakoutOf"],
      message: "A breakout carries its parent Channel and a Channel carries none",
    });
  }
  if (conversation.breakoutOf && conversation.breakoutOf.substreamId !== conversation.id) {
    context.addIssue({
      code: "custom",
      path: ["breakoutOf", "substreamId"],
      message: "A breakout's id is its substream id",
    });
  }
});
export type SpaceConversation = z.infer<typeof SpaceConversationSchema>;

/**
 * One page of the conversations a Space currently needs this viewer for.
 *
 * The route is still `GET /spaces/:id/channels` and this is still the answer
 * to it, but what it answers is *conversations*: the Space's member Channels
 * and those Channels' breakouts in one list, newest activity first, with
 * everything that is stale for this viewer left out entirely
 * (`conversationNeedsViewer`). The name is kept because the route is, and
 * renaming a shipped path to describe its payload buys a reader nothing.
 *
 * The same rows the Channel directory serves, shaped for the viewer: General
 * holds every Channel in the Organization, so this is the one Space read that
 * cannot ride the workspace socket. It answered bare ids first, which made the
 * Space dashboard able to name only the Channels that happened to be in the
 * device's loaded directory page and say nothing about the rest — and a second
 * read per id would have been a round trip per row.
 *
 * It lives here rather than in `spaces.ts` because a page of conversations is
 * made of `WorkstreamSchema`, which is declared in this file; `spaces.ts` is
 * imported by it and cannot import back.
 *
 * Opaque cursor: the ordering is the authority's, and a client that could
 * construct a cursor could ask for a page the ordering no longer has. A page
 * may be shorter than the cursor suggests, because a membership the viewer may
 * not read is dropped after the page is taken.
 */
export const SpaceChannelPageSchema = z.strictObject({
  items: z.array(SpaceConversationSchema),
  nextCursor: z.string().min(1).nullable(),
});
export type SpaceChannelPage = z.infer<typeof SpaceChannelPageSchema>;

/**
 * One row of a Channel's feed: a thread placed in it that the viewer may open,
 * newest placement first. A private thread the viewer is not in is not a row.
 * `kind` stays because desktops shipped since 1.563 parse this row by it; it
 * can go once those builds no longer reach the API.
 */
export const ChannelFeedItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("thread"),
    placedAt: TimestampSchema,
    /** The placement's position in the Channel's unread order (`ChannelStats`). */
    attentionSequenceNumber: z.number().int().nonnegative(),
    thread: WorkstreamSchema,
  }),
  /**
   * A message in the Channel itself, outside any thread. Served only to a
   * build at `CHANNEL_MESSAGES_CLIENT_CONTRACT` or later: a build before it
   * parses a feed row as a thread. See docs/spaces.md#channel-messages.
   */
  z.strictObject({
    kind: z.literal("message"),
    placedAt: TimestampSchema,
    /**
     * The message's position in the Channel's unread order, zero for one that
     * is not news (a Channel's opening messages). Absent for a build before
     * `CHANNEL_MERGES_CLIENT_CONTRACT`.
     */
    attentionSequenceNumber: z.number().int().nonnegative().optional(),
    message: ChannelMessageSchema,
  }),
]);
export type ChannelFeedItem = z.infer<typeof ChannelFeedItemSchema>;

/** One page of a Channel's feed. Opaque cursor, as on every Space read. */
export const ChannelFeedPageSchema = z.strictObject({
  items: z.array(ChannelFeedItemSchema),
  nextCursor: z.string().min(1).nullable(),
  /**
   * The Channel's latest attention sequence number as the first page was read
   * (`ChannelStats.latestAttentionSequenceNumber`); null on a later page.
   * A reader reaching the newest end may acknowledge through it, including
   * placements no longer listed. Loading this page alone does not mean its
   * rows have been seen: a visit can open at an older read waterline.
   */
  latestAttentionSequenceNumber: z.number().int().nonnegative().nullable(),
});
export type ChannelFeedPage = z.infer<typeof ChannelFeedPageSchema>;

/**
 * One page of the threads and breakouts this person takes part in, newest
 * activity first: the Threads tab. Rows are the dashboard's conversation rows,
 * so a breakout carries its thread for the chip it prints.
 */
export const MyThreadsPageSchema = z.strictObject({
  items: z.array(SpaceConversationSchema),
  nextCursor: z.string().min(1).nullable(),
  /**
   * On the first page, every thread and breakout this person pinned and may
   * still list, whatever page its activity would put it on; empty on a later
   * page. The Pinned section is drawn from this.
   */
  pinned: z.array(SpaceConversationSchema),
});
export type MyThreadsPage = z.infer<typeof MyThreadsPageSchema>;

export const WorkstreamDetailSchema = WorkstreamSchema.extend({
  /** Durable safe-boundary stop request for the one substream-owned loop. */
  stopRequested: z.boolean().optional(),
  participants: z.array(ParticipantSchema),
  viewers: z.array(ViewerSchema),
  resources: z.array(WorkstreamResourceSchema),
  connections: z.array(ConnectionSchema),
  backgroundTasks: z.array(BackgroundTaskSchema).default([]),
  openElicitations: z.array(ElicitationSchema),
  /**
   * Rollout tombstone for desktop builds that still require this response key.
   * New Workers always serialize an empty array and current clients ignore it.
   */
  suggestions: z.array(z.unknown()).default([]),
  latestHarnessRunId: IdSchema.nullable(),
  latestHarnessRun: HarnessRunMetadataSchema.nullable().optional(),
});

export const WorkstreamContextSchema = z.object({
  /**
   * Vestigial, and read by nothing. Artifacts were removed in this release, but
   * this one schema is parsed on **both** sides of the wire — the route parses
   * its own response with it, and the desktop parses that response with the same
   * copy — so it has to tolerate both directions of version skew across a
   * rollout, and `GET /:id/context` is what fills the work-stream context rail.
   *
   * Old client, new server: a build in the wild bundles a copy that *requires*
   * the field — unlike `WorkstreamDetailSchema`, which defaulted it — so leaving
   * it out fails the whole response. `.default([])` is what puts it on the wire.
   *
   * New client, old server: a Worker that predates this release still returns
   * real rows here, and regional deploys before Global, so one region runs the old
   * Worker for part of every rollout and indefinitely if the other half fails.
   * The element type is therefore permissive rather than `never`: rejecting a
   * populated array would fail the whole response for the same reason, one
   * direction over. Emptiness is the *server's* invariant and is enforced where
   * the server is — `WorkstreamService.context` returns only `backgroundTasks`,
   * and `workstream-response-contracts.test.ts` asserts `[]` on the raw body.
   *
   * Drop the field one release after the build carrying this change ships. Do
   * not write a fixed version number here: this comment already named one that
   * went stale while the branch waited, when `main` shipped two releases without
   * it.
   */
  artifacts: z.array(z.unknown()).default([]),
  backgroundTasks: z.array(BackgroundTaskSchema)
});

export const TriggerDefinitionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({ type: z.literal("inbound_email") }),
  z.object({
    type: z.literal("calendar"),
    rrule: z.string().min(1),
    /**
     * The zone the recurrence's wall-clock time is read in, or `null` when
     * nobody named one.
     *
     * Null is the ordinary case and it is load-bearing, not a gap: it is what
     * distinguishes a zone somebody asked for from one nothing but a default
     * would answer, and it survives all the way into storage so that every
     * later reader resolves it against the account the automation actually runs
     * for — explicit trigger, then the owner's `users.timezone`, then
     * `workspaces.timezone`, read where the `schedules` row is derived. Filling
     * a default in earlier makes the two indistinguishable, and then a draft
     * created under a different scope than the compiler suggested, and every
     * copy of a shared template, silently keeps the drafting session's answer.
     */
    timezone: IanaTimezoneSchema.nullable(),
    summary: z.string().min(1)
  }),
  z.object({
    type: z.literal("interval"),
    intervalSeconds: z.number().int().min(60),
    summary: z.string().min(1)
  }),
  z.object({
    type: z.literal("connector_activity"),
    connectorType: z.string().min(1),
    sourceBindingKey: ActivitySourceBindingKeySchema.optional(),
    suggestedSourcePluginId: ModelPluginIdSchema.optional(),
    eventTypes: z.array(z.string().min(1)).min(1),
    deterministicFilters: z.record(z.string(), z.unknown())
  }),
  z.object({
    type: z.literal("semantic_activity"),
    connectorType: z.string().min(1).nullable(),
    sourceBindingKey: ActivitySourceBindingKeySchema.optional(),
    suggestedSourcePluginId: ModelPluginIdSchema.optional(),
    deterministicPrefilter: z.record(z.string(), z.unknown()),
    condition: z.string().min(1)
  }),
  z.object({ type: z.literal("resource_watch"), resourceId: IdSchema }),
  z.object({
    type: z.literal("webhook"),
    sourceBindingKey: ActivitySourceBindingKeySchema.optional(),
    suggestedSourcePluginId: ModelPluginIdSchema.optional(),
    eventTypes: z.array(z.string()).min(1)
  })
]);

/**
 * Whether a trigger's events are decided by an external-event evaluator rule.
 *
 * The three kinds are spelled out in several places across the tree; this is
 * the one that the enforcement path reads. Both boundaries that require rules —
 * `admitAuthoredDraft` when a draft is submitted, `prepareAcceptance` when one
 * is accepted — go through it, because the defect they exist to catch is what
 * happens when they disagree about which triggers need rules. It lives beside
 * the union it discriminates so a kind added there is one file away from the
 * question of whether it needs an evaluator.
 */
/**
 * The trigger kinds that arrive from outside Rally, and so bind to a connector.
 *
 * Written as a type predicate rather than a `boolean` so a caller that has
 * filtered on it can read `sourceBindingKey` and `suggestedSourcePluginId`
 * without re-narrowing. Those two fields exist only on this side of the union,
 * which is the whole reason the predicate is worth having.
 */
export type ExternalEventTrigger = Extract<
  z.infer<typeof TriggerDefinitionSchema>,
  { type: "connector_activity" | "semantic_activity" | "webhook" }
>;
export function isExternalEventTrigger(
  trigger: z.infer<typeof TriggerDefinitionSchema>,
): trigger is ExternalEventTrigger {
  return trigger.type === "connector_activity"
    || trigger.type === "semantic_activity"
    || trigger.type === "webhook";
}

/**
 * The written conditions that gate one event type, and the connector they watch.
 *
 * A `semantic_activity` trigger's `deterministicPrefilter.eventType` is the one
 * event type a ready trigger must name, which makes it the join between a stored
 * condition and an arriving event. Until the condition was evaluated at all that
 * field had no runtime reader either: the readiness refinement demanded it and
 * nothing consulted it.
 *
 * A trigger that names no event type gates every event reaching it. That is the
 * fail-closed direction, and it is reachable only for a definition accepted
 * without the refinement that forbids it — where the alternative would be to
 * apply no condition, which is the behavior this whole mechanism exists to end.
 *
 * Several conditions are an OR: several triggers are several independent reasons
 * to start one Sidekick, the same reading an evaluator rule set already gets.
 */
export function semanticConditionsForEventType(
  definition: { triggers: ReadonlyArray<z.infer<typeof TriggerDefinitionSchema>> } | null,
  eventType: string,
): { conditions: string[]; connectorType: string | null; gated: boolean } {
  const semantic = (definition?.triggers ?? []).filter(
    (trigger): trigger is Extract<z.infer<typeof TriggerDefinitionSchema>, { type: "semantic_activity" }> =>
      trigger.type === "semantic_activity",
  );
  const matching = semantic.filter((trigger) => {
    const declared = trigger.deterministicPrefilter["eventType"];
    return typeof declared !== "string" || declared.trim().length === 0 || declared === eventType;
  });
  const named = [...new Set(matching.map((trigger) => trigger.connectorType).filter(
    (connectorType): connectorType is string => connectorType !== null,
  ))];
  return {
    conditions: matching.map((trigger) => trigger.condition),
    /**
     * The connector the classifier is shown, and only when it is not in doubt.
     *
     * It reaches the model as `candidate_event.connector` — in the untrusted half
     * of the state, as evidence — so naming the wrong one is worse than naming
     * none. This used to take the first non-null value across every matching
     * trigger, which is wrong exactly when two of them name different connectors:
     * reachable through the documented "a trigger that names no event type gates
     * every event", where a Slack event judged against a GitHub trigger's
     * condition would have been shown `connector: "github"`. The delivery does
     * not carry the event's own connector, so where the triggers disagree there
     * is nothing honest to say and it says nothing.
     */
    connectorType: named.length === 1 ? named[0]! : null,
    /**
     * Whether this definition gates events at all, regardless of which ones matched.
     *
     * Read together with an empty `conditions`, this is the difference between
     * "nothing here is gated" and "something here is gated and the join found
     * none of it" — and the second must not admit. A semantic trigger whose
     * declared event type has drifted from the one its evaluator rule actually
     * registered would otherwise fall through to an ungated run, which is
     * precisely the defect this whole mechanism exists to fix, reintroduced
     * silently and with no log line distinguishing it from a clean admission.
     */
    gated: semantic.length > 0,
  };
}

export const AutomationDraftSchema = z.object({
  name: z.string().min(1).max(140),
  description: z.string().min(1).max(1200),
  overview: z.string().min(1).max(3000),
  instructions: z.string().min(1).max(12000),
  triggers: z.array(TriggerDefinitionSchema),
  definitionVersion: z.literal(2).optional(),
  whenToUse: z.string().optional(),
  requiredCapabilities: z.array(z.string()).default([]),
  expectedOutputs: z.array(z.string()).default([]),
  defaultBehavior: z.record(z.string(), z.unknown()).default({}),
  recommendedPlugins: z.array(AutomationPluginRecommendationSchema).default([]),
  memoryTables: z.array(AutomationMemoryTableSchema).default([]),
  /**
   * Who will be able to see and change this automation, asked before it is
   * submitted because it cannot be changed afterwards. `workstream` is the room
   * the authoring run happened in — there is no ID to name here and none can
   * be, because no other room is reachable.
   */
  suggestedScope: AutomationScopeSchema,
  followUpQuestion: z.string().nullable(),
  elicitation: AutomationDraftElicitationSchema.nullable().default(null),
  ready: z.boolean()
}).superRefine((draft, context) => {
  const names = new Set<string>();
  draft.memoryTables.forEach((table, index) => {
    const normalized = table.name.toLocaleLowerCase();
    if (names.has(normalized)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["memoryTables", index, "name"],
        message: "Memory-table names must be unique within an automation",
      });
    }
    names.add(normalized);
  });
  const sourceBindings = new Map<string, { connectorType: string; pluginId: string }>();
  draft.triggers.forEach((trigger, index) => {
    if (trigger.type !== "connector_activity" && trigger.type !== "semantic_activity" && trigger.type !== "webhook") return;
    const connectorType = trigger.type === "webhook" ? "generic_webhook" : trigger.connectorType;
    if (!draft.ready) return;
    if (!trigger.sourceBindingKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggers", index, "sourceBindingKey"],
        message: "Ready activity triggers require a source binding key",
      });
    }
    if (!trigger.suggestedSourcePluginId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggers", index, "suggestedSourcePluginId"],
        message: "Ready activity triggers require an inspected source plugin",
      });
    }
    if (trigger.type === "semantic_activity" && connectorType == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggers", index, "connectorType"],
        message: "Ready semantic activity triggers require a concrete connector type",
      });
    }
    if (
      trigger.type === "semantic_activity"
      && (typeof trigger.deterministicPrefilter.eventType !== "string" || trigger.deterministicPrefilter.eventType.trim().length === 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggers", index, "deterministicPrefilter", "eventType"],
        message: "Ready semantic activity triggers require one declared event type",
      });
    }
    if (!trigger.sourceBindingKey || !trigger.suggestedSourcePluginId || !connectorType) return;
    const previous = sourceBindings.get(trigger.sourceBindingKey);
    if (previous && (previous.connectorType !== connectorType || previous.pluginId !== trigger.suggestedSourcePluginId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggers", index, "sourceBindingKey"],
        message: "Reused activity source binding keys must identify the same connector and suggested plugin",
      });
      return;
    }
    sourceBindings.set(trigger.sourceBindingKey, { connectorType, pluginId: trigger.suggestedSourcePluginId });
  });
});

/**
 * Everything acceptance needs that the draft has already decided.
 *
 * Acceptance used to take these as request fields, because the wizard that
 * preceded the proposal card asked a member to choose them. That wizard is
 * gone, and the drafting loop answers the same questions earlier and with more
 * evidence: a ready draft's activity trigger names its own binding key and the
 * plugin the model loaded and inspected against a live connection activation,
 * and its recommended plugins were held to the same rule. Reading them back off
 * the definition is therefore not a fallback for a missing request field, it is
 * the only source that was ever authoritative.
 *
 * Derivation alone proves nothing about the present: a connection can be
 * revoked between drafting and Create, so acceptance still resolves each plugin
 * against the workspace's connections. That check is what the request field's
 * absence exposes rather than hides.
 */
/**
 * Each binding key the triggers declare, mapped to the plugin its trigger
 * suggested. A trigger that has not yet named both is not a source anything can
 * bind to and is left out.
 *
 * The one definition of that map: acceptance, the template catalog, and the
 * drafting tools all used to spell it out by hand, with filters that had begun
 * to drift, and a trigger kind added to `isExternalEventTrigger` would have had
 * to be added to each of them.
 */
export function automationActivitySourcePluginIds(
  triggers: ReadonlyArray<AutomationDraft["triggers"][number]>,
): Record<string, string> {
  const activitySourcePluginIds: Record<string, string> = {};
  for (const trigger of triggers) {
    if (!isExternalEventTrigger(trigger)) continue;
    if (!trigger.sourceBindingKey || !trigger.suggestedSourcePluginId) continue;
    activitySourcePluginIds[trigger.sourceBindingKey] = trigger.suggestedSourcePluginId;
  }
  return activitySourcePluginIds;
}

export function automationAcceptanceSelections(draft: AutomationDraft): {
  activitySourcePluginIds: Record<string, string>;
  defaultPluginIds: string[];
} {
  return {
    activitySourcePluginIds: automationActivitySourcePluginIds(draft.triggers),
    defaultPluginIds: [...new Set(draft.recommendedPlugins.map((plugin) => plugin.pluginId))],
  };
}

/** Why a draft could not be accepted as written, in the object's own vocabulary. */
export type AutomationDraftAcceptanceBlocker =
  | "sidekick_evaluator_rules_required"
  | "sidekick_activity_source_unbound";

/**
 * What would stop this draft being accepted, decided from the draft alone.
 *
 * Submission and acceptance both call this, which is the whole point: a draft
 * the first admits as `ready` and the second refuses reaches a person as a
 * proposal card whose Create button cannot work, with nothing on it to act on.
 * `evaluatorRulesMissing` was the first field to be shared this way after
 * exactly that defect; every check here is one that used to be enforced only at
 * the far end, or not at all.
 *
 * It answers only what a draft can settle for itself. Whether a named plugin
 * still resolves to a healthy connection the caller may bind is not knowable
 * here and is deliberately left to acceptance, where it is a refusal about the
 * present rather than about the draft.
 */
export function automationDraftAcceptanceBlocker(
  draft: AutomationDraft,
  rules: AutomationSetEvaluatorRulesInputV1 | null,
): AutomationDraftAcceptanceBlocker | null {
  const external = draft.triggers.filter(isExternalEventTrigger);
  if (external.length > 0 && (rules?.evaluators.length ?? 0) === 0) {
    return "sidekick_evaluator_rules_required";
  }
  // Every evaluator has to name a binding the triggers actually declare.
  // Triggers and rules are written by two separate tool calls, so this is the
  // one place their agreement is checked directly rather than inferred from a
  // request field that happened to carry both.
  const { activitySourcePluginIds } = automationAcceptanceSelections(draft);
  for (const evaluator of rules?.evaluators ?? []) {
    const bound = activitySourcePluginIds[evaluator.source.sourceBindingKey];
    if (!bound || bound !== evaluator.source.suggestedSourcePluginId) {
      return "sidekick_activity_source_unbound";
    }
  }
  return null;
}

/**
 * What a run reads from its automation at start, by definition revision.
 *
 * The run carries only `AutomationRunReferenceV1` into its loop; this is the
 * answer to that reference. Everything a run needs to act is here, resolved by
 * the parent at the moment the run asks, so nothing is frozen by copy and no
 * later field change has to migrate stored run contexts.
 */
export const AutomationRunDefinitionV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  automationId: IdSchema,
  runId: IdSchema,
  definitionRevision: z.number().int().positive(),
  definition: z.strictObject({
    name: z.string().min(1),
    description: z.string().min(1),
    overview: z.string().min(1),
    instructions: z.string().min(1),
    requiredCapabilities: z.array(z.string()),
    expectedOutputs: z.array(z.string()),
    defaultBehavior: z.record(z.string(), z.unknown()),
    recommendedPlugins: z.array(AutomationPluginRecommendationSchema),
    memoryTables: z.array(AutomationMemoryTableSchema),
  }),
  defaultPluginIds: z.array(ModelPluginIdSchema),
  activitySourcePluginIds: ActivitySourcePluginIdsSchema,
  connectorBindings: z.record(z.string(), z.string()),
  scope: AutomationScopeSchema,
  /** The Channel that owns a `workstream`-scoped automation; null for the other two scopes. */
  owningWorkstreamId: IdSchema.nullable(),
  /**
   * The home conversation under `owningWorkstreamId`: `"0"` for the Channel's
   * Main conversation, a Breakout id otherwise. The home is where a run posts
   * by default with `conversation_post`.
   */
  owningSubstreamId: SubstreamIdSchema.default("0" as SubstreamId),
  runAsUserId: IdSchema,
  modelOverride: z.string().min(1).nullable(),
  trigger: AutomationRunTriggerV1Schema,
  /**
   * The content that started the run, rendered as loop input: the email for
   * an inbound-email run, the event for an external-event run. Only an email
   * is also a resource.
   */
  opening: z.strictObject({
    textContent: z.string().min(1),
    structuredContent: z.record(z.string(), z.unknown()),
    resourceId: IdSchema.nullable(),
  }).nullable(),
  state: z.enum(["pending", "running", "needs_input", "completed", "failed", "stopped"]),
});
export type AutomationRunDefinitionV1 = z.infer<typeof AutomationRunDefinitionV1Schema>;

export const AutomationRunStatusSchema = z.enum([
  "pending", "running", "needs_input", "completed", "failed", "stopped",
]);

/**
 * The Thread that owns a `workstream`-scoped Sidekick, as the library and the
 * detail header name it: its title and the glyph it chose. Sent only to a
 * reader who is a participant of that Thread, so a Sidekick someone still
 * reads as its author never reveals a Thread they have left.
 */
export const AutomationOwningThreadSchema = z.object({
  id: IdSchema,
  title: z.string(),
  appearance: WorkstreamAppearanceSchema.optional(),
});
export type AutomationOwningThread = z.infer<typeof AutomationOwningThreadSchema>;

export const AutomationSummarySchema = z.object({
  loadable: z.boolean().default(false),
  /**
   * The Sidekick's chosen icon and colour, from the same catalog a work stream
   * picks from. Optional, and absent until somebody chooses: every Sidekick
   * that predates the picker keeps the mark derived from its id.
   */
  appearance: WorkstreamAppearanceSchema.optional(),
  id: IdSchema,
  name: z.string(),
  description: z.string(),
  emailAddress: z.string().email().nullable().default(null),
  scope: AutomationScopeSchema,
  /** The room that owns a `workstream`-scoped automation; null for the other two. */
  owningWorkstreamId: IdSchema.nullable().default(null),
  /** The owning Thread's name and glyph; null for the other scopes and when the reader is not in it. */
  owningThread: AutomationOwningThreadSchema.nullable().default(null),
  status: z.enum(["draft", "active", "paused"]),
  nextRunAt: TimestampSchema.nullable(),
  lastRunAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
});

/**
 * One automation in a work stream's rail: the summary without its scope and
 * owner, because every row in that list is owned by the work stream showing it.
 */
export const WorkstreamAutomationSummarySchema = AutomationSummarySchema.omit({
  scope: true,
  owningWorkstreamId: true,
  owningThread: true,
});
export type WorkstreamAutomationSummary = z.infer<typeof WorkstreamAutomationSummarySchema>;

/**
 * What a takeover did. `unboundProviders` is why this is not a bare
 * acknowledgement: the claimant may have no connection for one of the
 * providers the last principal took with them.
 */
export const AutomationExecutionPrincipalClaimSchema = z.strictObject({
  principalUserId: IdSchema,
  reboundPluginIds: z.array(z.string().min(1)),
  unboundProviders: z.array(z.string().min(1)),
  /** False when the caller already ran it and nothing needed rebinding. */
  changed: z.boolean(),
});
export type AutomationExecutionPrincipalClaim =
  z.infer<typeof AutomationExecutionPrincipalClaimSchema>;

export const AutomationRunSchema = z.object({
  /** The run id, which is also its substream under the automation. */
  id: IdSchema,
  automationId: IdSchema,
  triggerType: z.enum(["manual", "schedule", "external_event", "inbound_email"]),
  plannedFor: TimestampSchema.nullable(),
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  status: AutomationRunStatusSchema,
  resultSummary: z.string().nullable(),
  createdAt: TimestampSchema,
});

export const AutomationDetailSchema = AutomationSummarySchema.extend({
  lifecycle: AutomationLifecycleStateSchema,
  authorUserId: IdSchema,
  runAsUserId: IdSchema,
  /** The latest submitted definition, or null before the chat has submitted one. */
  currentDefinition: AutomationDraftSchema.nullable(),
  currentDefinitionRevision: z.number().int().nonnegative(),
  /** The revision that is running, or null while still a draft. */
  acceptedDefinitionRevision: z.number().int().positive().nullable(),
  /** Dedicated execution eligibility, independent of loading policy. */
  runnable: z.boolean().default(false),
  connectorBindings: z.record(z.string(), z.string()),
  recentRuns: z.array(AutomationRunSchema),
});

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().nullable(),
    details: z.record(z.string(), z.unknown()).optional()
  })
});

export const CursorPageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

/**
 * The Rally staff member acting as `user` in a support session
 * (`docs/impersonation.md`). Present only on a session a staff member started
 * from the account menu; every other session leaves it out.
 */
export const SessionImpersonatorSchema = UserSchema.pick({ id: true, email: true, name: true, avatarUrl: true });
export type SessionImpersonator = z.infer<typeof SessionImpersonatorSchema>;

export const SessionSchema = z.object({
  accessToken: z.string().min(20),
  refreshToken: z.string().min(20),
  expiresAt: TimestampSchema,
  user: UserSchema,
  workspace: WorkspaceSchema.nullable(),
  impersonator: SessionImpersonatorSchema.optional(),
  apiBaseUrl: HttpUrlSchema
});

export const DesktopExchangeRequestSchema = z.object({
  ticket: z.string().min(20).max(500),
  region: RegionSchema,
  attemptId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u),
  /**
   * The signing-in machine's zone, which seeds an account that has never chosen
   * one. Optional rather than defaulted: a client that sends nothing knows
   * nothing, and answering that with a zone wrote Pacific onto accounts whose
   * own setting was the only real answer anyone had.
   */
  timezone: IanaTimezoneSchema.optional()
});
export const ConnectorOAuthProviderSchema = z.enum(ConnectorOAuthProviders);
export const ConnectorOAuthAttemptStatusSchema = z.enum(["pending", "succeeded", "denied", "failed"]);
export const ConnectorOAuthStartSchema = z.object({
  url: HttpUrlSchema,
  attemptId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
export const ConnectorOAuthAttemptSchema = z.object({
  attemptId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  provider: ConnectorOAuthProviderSchema,
  status: ConnectorOAuthAttemptStatusSchema,
  connectionId: IdSchema.nullable(),
  errorCode: z.string().regex(/^[a-z0-9_-]{1,100}$/u).nullable(),
  expiresAt: TimestampSchema,
});
export const RefreshTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,500}$/u);
export const RefreshRequestSchema = z.object({ refreshToken: RefreshTokenSchema });
/**
 * A person choosing their timezone in Settings. `followDevice` true means
 * Set timezone automatically: the account follows whichever device reports its zone, and
 * `timezone` is this device's zone. Absent or false fixes it to `timezone`.
 */
export const UpdateUserTimezoneRequestSchema = z.object({
  timezone: IanaTimezoneSchema,
  followDevice: z.boolean().optional(),
});
/** A client reporting the zone its device is in; applied only while the account follows the device. */
export const DeviceTimezoneRequestSchema = z.object({ timezone: IanaTimezoneSchema });
/** The account's timezone and whether it follows the device or was fixed by hand. */
export const UserTimezoneSchema = z.object({
  timezone: IanaTimezoneSchema,
  followsDevice: z.boolean(),
});
export type UserTimezone = z.infer<typeof UserTimezoneSchema>;
/** A member's personal system prompt for one Organization; empty means none. */
export const PersonalSystemPromptSchema = z.strictObject({ personalSystemPrompt: z.string() });
export type PersonalSystemPrompt = z.infer<typeof PersonalSystemPromptSchema>;
/**
 * A member's display preferences for one Organization. Whole on read and on
 * write. Not strict: a client must keep reading the preferences it knows when
 * a newer server adds one, and unknown keys are stripped rather than refused.
 */
/**
 * The push switches a client older than `NotificationChannelsSchema` reads
 * and writes. Each kind's switch mirrors whether that kind's channels include
 * `push`. The two narrower switches no longer change what is sent; they stay
 * so an older client can still parse the record.
 */
export const PushPreferencesSchema = z.object({
  mentions: z.boolean(),
  added: z.boolean(),
  newThreads: z.boolean(),
  newThreadsOutsideMyChannels: z.boolean(),
  newBreakouts: z.boolean(),
  runFinished: z.boolean(),
  runFinishedOthers: z.boolean(),
});
export type PushPreferences = z.infer<typeof PushPreferencesSchema>;
export const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  mentions: true,
  added: true,
  newThreads: true,
  newThreadsOutsideMyChannels: true,
  newBreakouts: true,
  runFinished: true,
  runFinishedOthers: true,
};
/**
 * Where one notification can reach a person: a push to their devices, an
 * email, or any surface a connector declares for delivering to a person
 * (`userDelivery`). A new connector surface joins through
 * `AutomationDeliveryTargetTypeSchema` and needs no change here.
 */
export const NotificationChannelSchema = z.union([z.literal("push"), AutomationDeliveryTargetTypeSchema]);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;
/** The kinds of Activity row a person chooses channels for, one per row in Settings. */
export const NotificationKindSchema = z.enum(["mentions", "added", "newThreads", "newBreakouts", "runFinished", "merges", "artifactUpdates"]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;
/**
 * Lenient on read: a channel this build does not know (a newer server's, or
 * one a rollback left stored) is dropped rather than failing the whole record.
 */
const NotificationChannelListSchema = z.array(z.string()).transform((channels) => [...new Set(channels.flatMap((channel) => {
  const known = NotificationChannelSchema.safeParse(channel);
  return known.success ? [known.data] : [];
}))]);
/**
 * How each kind reaches this person. An empty list means it is only in
 * Activity and the daily digest.
 */
export const NotificationChannelsSchema = z.object({
  mentions: NotificationChannelListSchema,
  added: NotificationChannelListSchema,
  newThreads: NotificationChannelListSchema,
  newBreakouts: NotificationChannelListSchema,
  runFinished: NotificationChannelListSchema,
  /** Defaulted: a server older than merges does not send it. */
  merges: NotificationChannelListSchema.default(["push"]),
  /** Defaulted: a server older than artifact pins does not send it. */
  artifactUpdates: NotificationChannelListSchema.default(["push"]),
});
export type NotificationChannels = z.infer<typeof NotificationChannelsSchema>;
/**
 * Some kinds' channels, as a save names them or a row stores them. The
 * defaults are unwrapped: a partial field still fills in its default, so a
 * save of one kind would otherwise reset every defaulted kind it left out.
 */
export const NotificationChannelsChoiceSchema = NotificationChannelsSchema
  .extend({
    merges: NotificationChannelsSchema.shape.merges.unwrap(),
    artifactUpdates: NotificationChannelsSchema.shape.artifactUpdates.unwrap(),
  })
  .partial();
export const DEFAULT_NOTIFICATION_CHANNELS: NotificationChannels = {
  mentions: ["push", "slack_agent_dm"],
  added: ["push", "slack_agent_dm"],
  newThreads: ["push"],
  newBreakouts: ["push"],
  runFinished: ["push"],
  merges: ["push"],
  artifactUpdates: ["push"],
};
export const MemberPreferencesSchema = z.object({
  /** Whether the transcript shows the agent's work: its thinking and its tool and plugin calls. */
  showAgentWork: z.boolean(),
  /**
   * What a client older than `notify` reads: each kind's switch is whether
   * `notify` lists `push` for it. Absent from a server older than it: read as
   * every default.
   */
  push: PushPreferencesSchema.default(DEFAULT_PUSH_PREFERENCES),
  /** Absent from a server older than it: read as every default. */
  notify: NotificationChannelsSchema.default(DEFAULT_NOTIFICATION_CHANNELS),
});
export type MemberPreferences = z.infer<typeof MemberPreferencesSchema>;
export const DEFAULT_MEMBER_PREFERENCES: MemberPreferences = {
  showAgentWork: true,
  push: DEFAULT_PUSH_PREFERENCES,
  notify: DEFAULT_NOTIFICATION_CHANNELS,
};
/**
 * A save. Each field, and each push switch, is optional so one control saves
 * only what it changed: everything a save leaves out keeps its stored value,
 * so a window with a stale copy cannot undo a change made elsewhere, and a
 * desktop older than the push switches (it saves `showAgentWork` alone)
 * leaves them as they were. An empty save changes nothing and is refused.
 */
export const MemberPreferencesUpdateSchema = z.object({
  showAgentWork: z.boolean().optional(),
  push: PushPreferencesSchema.partial().optional(),
  /** Each kind named replaces that kind's channels whole. */
  notify: NotificationChannelsChoiceSchema.optional(),
}).refine((value) => value.showAgentWork !== undefined
  || Object.values(value.push ?? {}).some((switched) => switched !== undefined)
  || Object.values(value.notify ?? {}).some((channels) => channels !== undefined), {
  message: "A preference to change is required.",
});
export type MemberPreferencesUpdate = z.infer<typeof MemberPreferencesUpdateSchema>;
/** Each field is optional so one control can save its own; an empty body changes nothing and is refused. */
export const UpdateWorkspaceRequestSchema = z.object({
  name: WorkspaceNameSchema.optional(),
  timezone: IanaTimezoneSchema.optional(),
}).refine((value) => value.name !== undefined || value.timezone !== undefined, {
  message: "Name or timezone is required.",
});

// --- Digest ---------------------------------------------------------------

/** Sunday through Saturday, matching `Date#getDay` so no table maps between. */
export const DigestWeekdaySchema = z.number().int().min(0).max(6);
/** Local wall-clock minute in the schedule's own timezone. */
export const DigestMinuteOfDaySchema = z.number().int().min(0).max(1439);

/**
 * A destination a digest can be sent to: the person's own Personal Channel,
 * where it arrives as a new thread; `email`, which needs no connector; or a
 * connector's declared `userDelivery` surface. A connector declaring a new
 * surface becomes a digest destination with no change here.
 */
export const DigestDeliveryTargetTypeSchema = z.union([z.literal("personal_channel"), AutomationDeliveryTargetTypeSchema]);

export const DigestDeliveryTargetSchema = z.object({
  type: DigestDeliveryTargetTypeSchema,
  connectionId: IdSchema.nullable().default(null),
  /** What the destination is called in the UI, frozen when it was chosen. */
  displayName: z.string().min(1).max(320),
  status: z.enum(["active", "needs_input", "disabled"]),
  lastDeliveredAt: TimestampSchema.nullable().default(null),
});

export const DigestScheduleSchema = z.object({
  id: IdSchema,
  enabled: z.boolean(),
  /** Deduplicated and ascending, so the UI never has to sort or dedupe. */
  days: z.array(DigestWeekdaySchema).max(7),
  times: z.array(DigestMinuteOfDaySchema).max(12),
  /**
   * Read-only. A digest runs in its owner's own day, so this mirrors their
   * account timezone rather than storing a second one that could disagree.
   */
  timezone: IanaTimezoneSchema,
  deliveryTargets: z.array(DigestDeliveryTargetSchema).max(8),
  nextRunAt: TimestampSchema.nullable(),
  lastDeliveredAt: TimestampSchema.nullable(),
});

/**
 * The one write. A digest is a small, wholly-owned configuration, so it is
 * replaced rather than patched — that keeps "no days selected" and "no times
 * selected" expressible, which a partial update cannot do.
 */
export const UpdateDigestScheduleRequestSchema = z.object({
  enabled: z.boolean(),
  days: z.array(DigestWeekdaySchema).max(7),
  times: z.array(DigestMinuteOfDaySchema).max(12),
  deliveryTargets: z.array(z.object({
    type: DigestDeliveryTargetTypeSchema,
    connectionId: IdSchema.nullable().default(null),
  })).max(8),
}).refine(
  // An enabled digest that names no day, no time, or nowhere to go would sit in
  // the scheduler forever without ever producing anything a person receives.
  (value) => !value.enabled
    || (value.days.length > 0 && value.times.length > 0 && value.deliveryTargets.length > 0),
  "An enabled digest needs at least one day, one time, and one destination",
);

export const WorkstreamCreationFieldsSchema = z.object({
  /**
   * The id the caller already listed this Channel under, so it can show it
   * before the create returns. Refused `workstream_id_unavailable` if any
   * conversation has it. Optional: a caller with nobody waiting on screen
   * leaves the id to the server.
   */
  workstreamId: WorkstreamIdSchema.optional(),
  /**
   * The Spaces this Channel is born in; the API reauthorizes every one of them.
   *
   * A list rather than one id because a Channel belongs to as many Spaces as it
   * was put in. Empty — which is what every connector, import, recovery and
   * scheduled path sends — means General: every Channel has a home, and no
   * caller without a person at a keyboard has one to choose. A Space named here
   * is established with the Channel or the creation fails without publishing
   * one, so there is no window in which a Channel exists outside the hierarchy.
   */
  spaceIds: z.array(SpaceIdSchema)
    .refine((ids) => new Set(ids).size === ids.length, "Space ids must be unique")
    .default([]),
  title: z.string().min(1).max(180).optional(),
  objective: z.string().trim().min(1).max(WORKSTREAM_DESCRIPTION_MAX_CHARACTERS).optional(),
  /**
   * Everyone the caller means to be in the room, uncapped.
   *
   * There used to be a `.max(25)` here, sized for a person naming the people
   * they are starting work with. A connector conversation is the other kind of
   * caller and is routinely larger — a Slack channel's resolved audience can be
   * hundreds — and a cap it exceeded did not degrade, it failed the whole
   * create on a Zod error. Truncating instead would have been Avalon deciding
   * that some of the people the conversation contains are not in the room,
   * which is the provider's fact to state, not ours. Every id here is still
   * checked against active workspace membership before a participant row is
   * written, so the list is bounded by the workspace in the only sense that
   * matters for access.
   */
  participantUserIds: z.array(IdSchema).default([]),
  openingMessage: z.string().max(MESSAGE_MAX_CHARACTERS),
  mentions: z.array(MentionSchema).default([]),
  clientMessageId: z.string().min(1).max(120),
  attachmentIds: z.array(IdSchema).max(10).default([]),
  annotations: AnnotationsSchema.optional(),
  /**
   * Pins every run of this work stream to one OpenRouter model, ahead of the
   * `agent-model-workstream` flag. Sent only by the composer's developer-mode
   * selector; omitted means the flag decides, which is what every other create
   * path does.
   */
  modelOverride: AgentModelOverrideSchema.optional(),
});

/** Interactive creation starts a run; prepared history uses the same creation fields. */
export const CreateWorkstreamRequestSchema = WorkstreamCreationFieldsSchema.superRefine(validateAnnotationAttachments).refine((value) => value.openingMessage.trim().length > 0 || value.attachmentIds.length > 0 || value.annotations?.some((annotation) => annotation.comment.trim().length > 0), {
  message: "An opening message must include text, an attachment or a commented annotation",
});

export const WorkOpportunitySchema = z.object({
  id: IdSchema,
  version: z.number().int().positive(),
  displayPrompt: z.string().min(1).max(180),
  icon: AutomationPluginIconSchema,
  sourceLabel: z.string().min(1).max(180),
});
export const WorkOpportunityPageSchema = z.object({
  items: z.array(WorkOpportunitySchema).max(4),
});
export const RecordWorkOpportunityImpressionsRequestSchema = z.object({
  opportunityIds: z.array(IdSchema).max(4),
  surface: z.enum(["menu_bar", "workspace_home"]),
});
export const StartWorkOpportunityRequestSchema = z.object({
  version: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(120),
  surface: z.enum(["menu_bar", "workspace_home"]).optional(),
  position: z.number().int().min(1).max(4).optional(),
});

export const UpdateWorkstreamRequestSchema = z.object({
  title: z.string().min(1).max(180).optional(),
  objective: z.string().max(WORKSTREAM_DESCRIPTION_MAX_CHARACTERS).optional(),
  archived: z.boolean().optional(),
  /**
   * Who may read it from now on. `personal` narrows the work stream to the
   * people already in it, `workspace` opens it to every member. Anyone who can
   * read a work stream may move it either way, because a private work stream is
   * shared work with a smaller room rather than one person's property.
   */
  scope: ScopeSchema.optional()
});

/**
 * A reusable cross-work-stream selection, expressed in product fields rather
 * than in the name of the surface that happened to build it.
 *
 * Both timestamps follow the ordinary half-open range convention. `pinned`
 * is viewer- and Space-specific; omitting it includes both pinned and unpinned
 * rows, and naming it requires the Space whose placement is being selected.
 *
 * The same range selects notes for `archive`, because a sidebar recency group
 * holds both and a person archiving one is archiving what they can see under
 * that heading. A note has no pin and no system kind, so `pinned: true`
 * selects none and `includeSystem` does not reach them.
 */
export const WorkstreamBatchFilterSchema = z.strictObject({
  /** Which timestamp the range selects; access falls back to creation for unvisited work streams. */
  recency: z.enum(["activity", "access"]).optional(),
  lastActivityAt: z.strictObject({
    atOrAfter: TimestampSchema.optional(),
    before: TimestampSchema.optional(),
  }).optional(),
  pinned: z.boolean().optional(),
  spaceId: SpaceIdSchema.optional(),
  includeSystem: z.boolean().default(false),
}).superRefine((filter, context) => {
  const atOrAfter = filter.lastActivityAt?.atOrAfter;
  const before = filter.lastActivityAt?.before;
  if (
    atOrAfter !== undefined
    && before !== undefined
    && Date.parse(atOrAfter) >= Date.parse(before)
  ) {
    context.addIssue({
      code: "custom",
      path: ["lastActivityAt", "before"],
      message: "must be later than atOrAfter",
    });
  }
  if (filter.pinned !== undefined && filter.spaceId === undefined) context.addIssue({
    code: "custom",
    path: ["spaceId"],
    message: "Space is required when filtering by pin state",
  });
});

/** The mutations the generic batch surface can currently enqueue. */
export const WorkstreamBatchUpdateSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("mark_read") }),
  z.strictObject({ kind: z.literal("archive") }),
]);

export const PreviewWorkstreamBatchRequestSchema = z.strictObject({
  filter: WorkstreamBatchFilterSchema,
});

/**
 * What one apply of this filter would touch, counted per authority.
 *
 * `matchedCount` is work streams and `matchedNoteCount` is notes, because the
 * two are separate authorities that a single count would have to add together
 * and then be unable to explain: only `archive` reaches notes, and only the
 * notes this viewer owns and is not recording can be archived at all. The
 * caller shows the note half for `archive` and ignores it for `mark_read`.
 */
export const WorkstreamBatchPreviewSchema = z.strictObject({
  matchedCount: z.number().int().nonnegative(),
  matchedNoteCount: z.number().int().nonnegative(),
});

export const ApplyWorkstreamBatchRequestSchema = z.strictObject({
  operationId: IdSchema,
  filter: WorkstreamBatchFilterSchema,
  update: WorkstreamBatchUpdateSchema,
});

/**
 * Work streams are *enqueued* and notes are *archived*, and the names say so:
 * each work stream leaves as one Queue event for the object that owns it, while
 * the notes live in the workspace object this request already reached and are
 * done by the time it answers.
 */
export const WorkstreamBatchAcceptedSchema = z.strictObject({
  operationId: IdSchema,
  enqueuedCount: z.number().int().nonnegative(),
  archivedNoteCount: z.number().int().nonnegative(),
});

export const AcknowledgeWorkstreamReadRequestSchema = z.object({
  readThroughSequenceNumber: z.number().int().nonnegative(),
  observedManualUnreadGeneration: z.number().int().nonnegative(),
  entrypoint: z.enum([
    'direct', 'sidebar_new', 'sidebar_pinned', 'sidebar_recent', 'sidebar_note', 'sidebar_automation',
    'home_waiting', 'home_suggested', 'menu_bar', 'command_shortcut', 'deep_link', 'notification',
    'automation_run_list', 'in_app_link', 'settings', 'unknown',
  ]).optional(),
});

/**
 * The whole pinned list in its new order, not a move of one row.
 *
 * A drag produces a complete arrangement, and sending that arrangement is what
 * lets the server write a dense run without inferring one from an index whose
 * meaning depends on a list state the client may no longer share. Ids the
 * caller has since unpinned elsewhere are ignored rather than rejected, and
 * pins the caller does not name keep their relative order behind the ones it
 * did — a second window that pinned something a moment ago loses its position,
 * never its pin.
 *
 * The same bound as pin creation. A reorder is an all-or-nothing complete
 * arrangement, so this must admit every state the server can create while
 * refusing a payload the object can never legitimately hold.
 */
export const MAX_WORKSTREAM_PIN_PLACEMENTS_PER_USER = 1_000;
export const ReorderWorkstreamPinsRequestSchema = z.object({
  spaceId: SpaceIdSchema,
  workstreamIds: z.array(IdSchema).max(MAX_WORKSTREAM_PIN_PLACEMENTS_PER_USER),
});

/** The authoritative visible pending-input queue after a reorder command. */
export const ReorderPendingLoopInputsResultSchema = z.object({
  pendingInputs: z.array(PendingTranscriptInputSchema),
});

export const CreateMessageRequestSchema = z.object({
  text: z.string().max(MESSAGE_MAX_CHARACTERS),
  clientMessageId: z.string().min(1).max(120),
  mentions: z.array(MentionSchema).default([]),
  confirmedParticipantUserIds: z.array(IdSchema).default([]),
  attachmentIds: z.array(IdSchema).max(10).default([]),
  /** Steer yields the in-flight loop at a turn boundary; queue never interrupts it. */
  annotations: AnnotationsSchema.optional(),
  runMode: z.enum(["steer", "queue"]).optional(),
}).superRefine(validateAnnotationAttachments).refine((value) => value.text.trim().length > 0 || value.attachmentIds.length > 0 || value.annotations?.some((a) => a.comment.trim()), {
  message: "A message must include text or an attachment",
});

export const AddParticipantRequestSchema = z.object({ userId: IdSchema });
const ElicitationAnswerValueSchema = z.union([
  z.string().trim().min(1).max(4000),
  z.array(z.string().trim().min(1).max(4000)).min(1).max(30)
]);
export const AnswerElicitationRequestSchema = z.union([
  z.strictObject({
    answer: ElicitationAnswerValueSchema,
    customResponse: z.string().trim().min(1).max(4000).optional(),
    skipped: z.literal(false).optional()
  }),
  z.strictObject({
    skipped: z.literal(true)
  })
]);
export const CreateWebhookConnectionRequestSchema = z.object({
  displayName: z.string().min(1).max(180),
  scope: ScopeSchema,
  eventTypes: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  idempotencyKey: z.string().trim().min(1).max(120).optional()
});

// --- Custom MCP servers ----------------------------------------------------

/** How a connection to a person-configured MCP server authenticates. */
export const CustomMcpAuthModes = ["oauth", "headers"] as const;
export const CustomMcpAuthModeSchema = z.enum(CustomMcpAuthModes);

/**
 * Which of a server's tools a connection exposes.
 *
 * `read_only_tools` keeps only what the server itself annotates `readOnlyHint`.
 * It narrows what Rally offers and relaxes nothing: an admitted tool still
 * uses conservative write execution and a record-before-execute receipt, because an
 * MCP annotation is a hint from the server rather than a promise to Rally.
 */
export const CustomMcpToolPolicies = ["all_tools", "read_only_tools"] as const;
export const CustomMcpToolPolicySchema = z.enum(CustomMcpToolPolicies);

/**
 * Header entries a connection may not set. Not a defensive limit but a
 * correctness boundary: the MCP transport decides each of these, and a
 * configured value winning would break the session or silently change what
 * Rally negotiated.
 */
const RESERVED_CUSTOM_MCP_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "mcp-protocol-version",
  "mcp-session-id",
  "transfer-encoding",
]);

/**
 * Bounds: header entries stored on one header-authenticated connection.
 * Set by the team on 2026-09-03; the reasoning is not recorded beyond the
 * value, which holds one credential header plus routing and tenant headers.
 * Trips: the create request is refused with a 422 and nothing is stored.
 */
export const MAX_CUSTOM_MCP_HEADERS = 16;

/**
 * Bounds: characters in one stored header value, which is held in memory,
 * encrypted at rest, and replayed on every request this connection makes.
 * Set by the team on 2026-09-03; 8 KB holds a long-lived signed token.
 * Trips: as above — refused before anything is written.
 */
export const MAX_CUSTOM_MCP_HEADER_VALUE_CHARS = 8_192;

/** RFC 9110 field names, minus the ones the MCP transport owns. */
export const CustomMcpRequestHeadersSchema = z.record(
  z.string()
    .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/u, "Expected an HTTP header name")
    .refine(
      (name) => !RESERVED_CUSTOM_MCP_HEADERS.has(name.toLowerCase()),
      "This header is set by the MCP transport",
    ),
  z.string()
    .min(1)
    .max(MAX_CUSTOM_MCP_HEADER_VALUE_CHARS)
    // A value carrying a newline is a request-splitting attempt, and `Headers`
    // would throw at the fetch rather than at the input.
    .regex(/^[\x20-\x7E\t]+$/u, "Expected a printable single-line header value"),
).refine(
  (headers) => {
    const count = Object.keys(headers).length;
    return count >= 1 && count <= MAX_CUSTOM_MCP_HEADERS;
  },
  `Expected between 1 and ${MAX_CUSTOM_MCP_HEADERS} headers`,
);

/**
 * The non-secret half of a custom MCP connection, held in `config_json`.
 *
 * The endpoint lives here rather than beside the credential because discovery,
 * execution, and the connections screen all need it, and a value only the
 * decryption path could see would leave a row unable to say which server it
 * points at.
 */
export const CustomMcpConnectionConfigSchema = z.looseObject({
  serverUrl: HttpsUrlSchema,
  authMode: CustomMcpAuthModeSchema,
  toolPolicy: CustomMcpToolPolicySchema.default("all_tools"),
});

const CustomMcpConnectionBaseSchema = z.object({
  displayName: z.string().trim().min(1).max(180),
  scope: ScopeSchema,
  serverUrl: HttpsUrlSchema,
});

/** Header-authenticated connections are written directly; no browser is involved. */
export const CreateCustomMcpConnectionRequestSchema = CustomMcpConnectionBaseSchema.extend({
  requestHeaders: CustomMcpRequestHeadersSchema,
  toolPolicy: CustomMcpToolPolicySchema.default("all_tools"),
});

/** An OAuth connection starts a standards-based authorization instead. */
export const StartCustomMcpConnectionRequestSchema = CustomMcpConnectionBaseSchema.extend({
  toolPolicy: CustomMcpToolPolicySchema.default("all_tools"),
});

export const CustomMcpToolSummarySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4_000),
  readOnly: z.boolean(),
  destructive: z.boolean(),
  available: z.boolean(),
});

/**
 * What the connections screen shows for one custom MCP connection.
 *
 * `tools` is read live from the server, so it is remote content: a client
 * renders it as text and never as instruction. `toolsUnavailable` carries the
 * reason a catalog could not be read, which is a different state from a server
 * that advertises nothing.
 */
export const CustomMcpConnectionSettingsSchema = z.object({
  connectionId: IdSchema,
  connectionName: z.string().min(1).max(180),
  scope: ScopeSchema,
  serverUrl: HttpsUrlSchema,
  authMode: CustomMcpAuthModeSchema,
  toolPolicy: CustomMcpToolPolicySchema,
  /** Whether this connection's scope allows the read-only policy to be chosen. */
  toolPolicyEditable: z.boolean(),
  tools: z.array(CustomMcpToolSummarySchema).max(128),
  toolsUnavailable: z.string().max(500).nullable().default(null),
});

export const UpdateCustomMcpToolPolicyRequestSchema = z.object({
  toolPolicy: CustomMcpToolPolicySchema,
});

/**
 * The REST recovery twin of the SubstreamAgent `snapshot` frame.
 *
 * Normal opens subscribe directly and paint the first snapshot. This response
 * remains for an explicit unavailable-state retry and is assembled by the same
 * room code so recovery cannot drift.
 */
export const WorkstreamBootSchema = WorkstreamDetailSchema.extend({
  transcript: WorkstreamTranscriptSnapshotSchema,
});

export const WORKSTREAM_REALTIME_MAX_FRAME_BYTES = 1_000_000;

export const SubstreamSocketMutationTypeSchema = z.enum([
  "create_message",
  "answer_elicitation",
  "reorder_pending_inputs",
  "set_workstream_appearance",
  "stop_harness",
  "retry_harness",
]);

export const ClientSocketEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("set_workstream_appearance"), operationId: IdSchema, appearance: WorkstreamAppearancePatchSchema }),
  z.strictObject({
    type: z.literal("subscribe"),
    afterSequence: z.number().int().nonnegative(),
    /**
     * Old desktop builds derived viewer presence from feed subscriptions. The
     * current desktop reports foreground presence through WorkspaceDO instead,
     * so its proactive feeds opt out while omitted remains legacy-compatible.
     */
    publishPresence: z.boolean().default(true),
  }),
  // A speculative feed may paint its snapshot before navigation commits. The
  // retained admitted socket sends this one-way promotion when the person
  // actually opens the work stream, keeping hover reads free of seen-state
  // writes without putting a request on the click-to-paint path.
  z.strictObject({ type: z.literal("mark_opened") }),
  // Re-send the canonical `snapshot` frame on a socket that is already
  // subscribed. It carries no cursor on purpose: a viewer asking for canonical
  // state is saying its own state may be wrong, so a cursor it supplied is the
  // one input that cannot be trusted to bound the answer. The room replies with
  // the same sequenced snapshot an initial subscription receives, which is what
  // lets the client's ordinary ordering guard decide whether to apply it.
  z.strictObject({ type: z.literal("request_snapshot") }),
  z.strictObject({
    type: z.literal("load_transcript_range"),
    requestId: IdSchema,
    request: WorkstreamTranscriptRangeRequestSchema,
  }),
  z.object({
    type: z.literal("create_message"),
    operationId: IdSchema,
    payload: CreateMessageRequestSchema,
  }),
  z.strictObject({
    type: z.literal("answer_elicitation"),
    operationId: IdSchema,
    elicitationId: IdSchema,
    payload: AnswerElicitationRequestSchema,
  }),
  z.strictObject({
    type: z.literal("reorder_pending_inputs"),
    operationId: IdSchema,
    // The whole visible order, not one move. Intentionally unbounded because
    // the durable queue itself has no count ceiling.
    inputIds: z.array(IdSchema),
  }),
  z.strictObject({ type: z.literal("stop_harness"), operationId: IdSchema }),
  z.strictObject({ type: z.literal("retry_harness"), operationId: IdSchema }),
  /**
   * The desktop's answer to a `desktop_action_requested` it executed. The
   * first answer to an action wins; a repeat is acknowledged and ignored.
   */
  z.strictObject({
    type: z.literal("answer_desktop_action"),
    actionId: z.string().min(1),
    outcome: DesktopActionOutcomeSchema,
  }),
]);

/** Workspace-owned query surfaces kept coherent by the one WorkspaceDO socket. */
export const WORKSPACE_SYNC_TOPICS = [
  "workspace_profile",
  "member_directory",
  "invitation_directory",
  "connector_connections",
  "connector_oauth_attempts",
  "terminal_policy",
  "digest_schedule",
  "automations",
  "notes",
  "projects",
  "resources",
  "activity",
  "work_opportunities",
  "workstream_directory",
  "viewer_preferences",
  "feature_flags",
] as const;
export const WorkspaceSyncTopicSchema = z.enum(WORKSPACE_SYNC_TOPICS);

/**
 * Opaque stable ordering cursor for the note list's `(recency, id)` order.
 *
 * It carries the stored `last_activity_at` verbatim rather than an epoch, the
 * way the work-stream cursor beside it does: `notes.last_activity_at` is an ISO
 * string and the list orders by it as text, so a cursor in any other spelling
 * would have to be converted on every comparison to page correctly. The id is
 * a UUID and has no colon of its own, so the last colon is the separator.
 */
export const NoteCursorSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu)
  .max(61);

/** Opaque stable ordering cursor for WorkspaceDO's `(recency, id)` directory. */
export const WorkspaceWorkstreamCursorSchema = z.string()
  .regex(/^\d{1,16}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu)
  .max(53);

/**
 * How many Channels one `channel_rails` request may name: `list_workstreams`'
 * page bound, reused rather than chosen. A `space_channels` page is this size
 * too.
 */
export const CHANNEL_RAILS_NAMED_LIMIT = 250;

export const WorkspaceSocketClientEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("subscribe"),
    afterWaterline: z.number().int().nonnegative(),
    diagnosticAttemptId: IdSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("set_presence"),
    revision: z.number().int().positive(),
    applicationState: z.enum(["foreground", "background"]),
    foregroundWorkstreamId: WorkstreamIdSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal("list_workstreams"),
    requestId: IdSchema,
    limit: z.number().int().min(1).max(250),
    before: WorkspaceWorkstreamCursorSchema.optional(),
    includeSystem: z.boolean(),
  }),
  /**
   * The Channel rail data for named Channels whose `railWaterline` moved.
   *
   * `spaceId` and `after` are the retired Space target, still sent by desktops
   * 1.467.0 and 1.468.0. They are accepted so those desktops are not
   * disconnected, and answered with one empty final frame.
   */
  z.strictObject({
    type: z.literal("channel_rails"),
    requestId: IdSchema,
    spaceId: SpaceIdSchema.optional(),
    after: WorkstreamIdSchema.optional(),
    workstreamIds: z.array(WorkstreamIdSchema).min(1).max(CHANNEL_RAILS_NAMED_LIMIT)
      .refine((ids) => new Set(ids).size === ids.length, "must be unique")
      .optional(),
  }),
  /**
   * One page of the Channels in a Space this viewer may see, in id order after
   * `after`, with their rails when `rails` is set.
   */
  z.strictObject({
    type: z.literal("space_channels"),
    requestId: IdSchema,
    spaceId: SpaceIdSchema,
    /** The `nextAfter` of the previous answer for this Space. */
    after: WorkstreamIdSchema.optional(),
    rails: z.boolean(),
  }),
]).superRefine((event, context) => {
  if (event.type === "set_presence"
    && event.applicationState === "background"
    && event.foregroundWorkstreamId !== null) {
    context.addIssue({
      code: "custom",
      path: ["foregroundWorkstreamId"],
      message: "must be null while the application is backgrounded",
    });
  }
});

const WorkstreamStateEventIdSchema = IdSchema.refine((value) => value[14] === "7", "must be UUIDv7");

/**
 * Coordinates one complete work-stream UI snapshot across its two authorities.
 *
 * `commonWaterline` orders the WorkstreamDO-owned shared row and
 * `viewerWaterline` orders the authenticated user's row. They are deliberately
 * independent: Cloudflare Queues is unordered, so advancing one must never
 * cause a delayed update for the other to be discarded. Each field carries
 * the UUIDv7 identity of its own state row unchanged over both socket paths;
 * those IDs are time-sortable traces, not a distributed total-order clock.
 */
export const WorkstreamStateVersionSchema = z.strictObject({
  commonEventId: WorkstreamStateEventIdSchema,
  viewerEventId: WorkstreamStateEventIdSchema.nullable(),
  authorityGeneration: z.number().int().positive(),
  commonWaterline: z.number().int().positive(),
  viewerWaterline: z.number().int().nonnegative(),
}).superRefine((version, context) => {
  if ((version.viewerWaterline === 0) !== (version.viewerEventId === null)) {
    context.addIssue({
      code: "custom",
      path: ["viewerEventId"],
      message: "must be null exactly when viewerWaterline is zero",
    });
  }
});

export const WorkspaceWorkstreamStateVersionSchema = WorkstreamStateVersionSchema.extend({
  workstreamId: IdSchema,
}).strict();

/**
 * The body of one cursor-paged directory answer, shared by both events that
 * carry it: the page a scroll asks for, and the page inside the opening
 * sidebar batch. Held as fields plus a refinement rather than a schema so both
 * can spread it into their own strict object — `superRefine` returns a
 * `ZodEffects`, which cannot be extended.
 */
const workspaceWorkstreamPageFields = {
  directoryWaterline: z.number().int().nonnegative(),
  items: z.array(WorkstreamSchema),
  stateVersions: z.array(WorkspaceWorkstreamStateVersionSchema),
  nextCursor: WorkspaceWorkstreamCursorSchema.nullable(),
} as const;

function refineWorkstreamPagePairing(
  page: { items: Array<{ id: string }>; stateVersions: Array<{ workstreamId: string }> },
  context: z.RefinementCtx,
): void {
  const itemIds = new Set(page.items.map((item) => item.id));
  const versionIds = new Set(page.stateVersions.map((version) => version.workstreamId));
  if (itemIds.size !== page.items.length
    || versionIds.size !== page.stateVersions.length
    || itemIds.size !== versionIds.size
    || [...itemIds].some((id) => !versionIds.has(id))) {
    context.addIssue({
      code: "custom",
      path: ["stateVersions"],
      message: "must contain exactly one state version for every work stream item",
    });
  }
}

/**
 * One page of a Space's Channel rows, answering `space_channels`.
 *
 * `rails` holds the rails that fit the frame beside the rows, and is empty
 * when none were asked for. A row with no rail here is asked for by name.
 * `nextAfter` is the last Channel on a full page, so the next request starts
 * after it; `null` means the Space ends here.
 */
export const WorkspaceSpaceChannelsEventSchema = z.strictObject({
  type: z.literal("workspace_space_channels"),
  requestId: IdSchema,
  directoryWaterline: z.number().int().nonnegative(),
  items: z.array(WorkstreamSchema),
  stateVersions: z.array(WorkspaceWorkstreamStateVersionSchema),
  rails: z.array(z.lazy(() => ChannelRailSchema)),
  nextAfter: WorkstreamIdSchema.nullable(),
}).superRefine(refineWorkstreamPagePairing);
export type WorkspaceSpaceChannelsEvent = z.infer<typeof WorkspaceSpaceChannelsEventSchema>;

/** A WorkspaceDO-owned, cursor-paged sidebar result sent on the workspace socket. */
export const WorkspaceWorkstreamPageEventSchema = z.strictObject({
  type: z.literal("workspace_workstream_page"),
  requestId: IdSchema,
  ...workspaceWorkstreamPageFields,
}).superRefine(refineWorkstreamPagePairing);

export const WorkspaceWorkstreamRecencyEventSchema = z.strictObject({
  type: z.literal("workspace_workstream_recency"),
  directoryWaterline: z.number().int().nonnegative(),
  workstream: WorkstreamSchema,
  stateVersion: WorkspaceWorkstreamStateVersionSchema,
}).superRefine((event, context) => {
  if (event.workstream.id !== event.stateVersion.workstreamId) {
    context.addIssue({ code: "custom", path: ["stateVersion"], message: "must identify the work stream" });
  }
});

/**
 * Everything the sidebar paints, sent unprompted when a workspace socket
 * subscribes.
 *
 * It answers no request and carries no correlation id: the ticket already
 * proved who connected and which workspace they opened, and all three lists are
 * WorkspaceDO's own SQLite — the directory, `automation_subscriptions` and
 * `notes`. There is nothing left for the client to tell the server before the
 * first paint, so it is not asked to.
 *
 * Deliberately serves the p95 and not the debug case: the directory page here
 * excludes system work streams. Turning Debug enabled on is rare, engineers
 * only, and re-draws the sidebar from a `list_workstreams` request carrying
 * `includeSystem` — a follow-up that a person's own action asked for. Loading
 * the common case unasked and paying a round trip for the rare one is the right
 * way round; the reverse would put a debug preference in everyone's connect.
 *
 * The automation and note arrays are bounded rather than paged: neither has a
 * cursor, and a workspace past the bound is served its first rows and
 * reconciled by the next push. A bound that truncates keeps a very large
 * sidebar painting; a bound that rejects would fail the whole connect.
 *
 * Sent on every subscribe, cold or resuming, so a client that missed pushes
 * while it was away is correct again without replaying the gap. A resume where
 * nothing moved costs the bytes and applies nothing: every list carries the
 * waterline its pushes carry, so the client's ordinary comparison drops it.
 */
export const WorkspaceSidebarSchema = z.strictObject({
  workstreams: z.strictObject(workspaceWorkstreamPageFields)
    .superRefine(refineWorkstreamPagePairing),
  automations: z.strictObject({
    waterline: z.number().int().nonnegative(),
    items: z.array(AutomationSummarySchema).max(250),
  }),
  notes: z.strictObject({
    waterline: z.number().int().nonnegative(),
    items: z.array(z.unknown()).max(250).transform(() => [] as never[]),
    /**
     * The next page, or `null` when this one is the whole list. Optional only
     * for the rolling deployment: a client that gets no cursor from an older
     * server reads the list as complete, which is what it did before paging.
     */
    nextCursor: NoteCursorSchema.nullable().optional(),
  }),
  /**
   * Both Space directories at one waterline, for this viewer.
   *
   * Optional so a client reading a payload from a server that predates it
   * treats the hierarchy as absent rather than failing the connect.
   */
  spaces: SpaceSnapshotSchema.optional(),
  /**
   * Every list this viewer has arranged by hand, whatever contains it.
   *
   * Beside the Space directories rather than inside one, because it is the
   * *viewer's* preference about three different containers — the Organization,
   * a Space, a Channel — and only the first of those is a Space fact at all. It
   * rides this payload because it is per viewer, it is small, and it has to
   * reach the screen in the same frame as the lists it orders.
   *
   * Optional for the reason `spaces` is: a client reading a payload from a
   * server that predates it draws every list in its natural order rather than
   * failing the connect.
   */
  ordering: PersonalOrderSchema.optional(),
  /**
   * This viewer's order for **All**'s Pinned section: Channel ids, first to
   * last. Its own field rather than a fourth kind in `ordering`, because a
   * shipped client reads an order kind it does not know as a malformed
   * ordering and drops the payload, while it ignores a key it does not know.
   * Absent from a server that predates it, which reads as no order.
   */
  pinnedOrder: PinnedOrderSchema.optional(),
  /**
   * This viewer's pins of every kind, each kind in their order: the Pinned
   * sections of the Channels and Threads tabs. A key of its own, absent from a
   * server that predates it, for the reason `pinnedOrder` is.
   */
  pins: PinListSchema.optional(),
  /** This viewer's pinned artifacts in their order; its own key for the reason `ArtifactPinSchema` gives. */
  artifactPins: ArtifactPinListSchema.optional(),
  /** Each listed Channel's thread count and last activity, for the Channels tab. */
  channelStats: z.array(ChannelStatsSchema).optional(),
  /**
   * False while the Organization has not finished creating General and placing
   * every Channel in it.
   *
   * The client shows the Organization-opening state rather than a hierarchy
   * that is half built — a Channel with no Space, or a Space directory missing
   * General, is not a state any surface is allowed to render. Optional and
   * read as `true` when absent, so a payload from a server without the cutover
   * is not permanently stuck opening.
   */
  spacesReady: z.boolean().optional(),
  /**
   * Set for a member once the Space hierarchy is whole: `workstreams` is then
   * empty, and the client asks each Space for its Channels. Absent (a guest,
   * or an Organization still opening) means `workstreams` is the directory's
   * first page.
   */
  channelsBySpace: z.literal(true).optional(),
});

/**
 * The workspace socket's synchronization event, and the sidebar it carries.
 *
 * `sidebar` is present on exactly one kind of event: the answer to `subscribe`.
 * A change broadcast never carries it — those go to every socket at once, and
 * the sidebar is read per viewer.
 *
 * `topics` may be empty only when the sidebar is there, which is the resume
 * where nothing else moved: the event exists to hand over current state, not to
 * report news. Everywhere else an event with no topics would be a broadcast
 * saying nothing, so the refinement keeps that impossible.
 */
export const WorkspaceSocketSyncEventSchema = z.strictObject({
  type: z.literal("workspace_sync"),
  eventId: WorkstreamStateEventIdSchema,
  waterline: z.number().int().nonnegative(),
  occurredAt: TimestampSchema,
  topics: z.array(WorkspaceSyncTopicSchema),
  reason: z.enum(["initial", "change", "history_unavailable", "resume"]),
  sidebar: WorkspaceSidebarSchema.optional(),
  /** Per-viewer values, present only on the private answer to subscribe. */
  featureFlags: ClientFeatureFlagsSchema.optional(),
  /** This viewer's display preferences, beside `featureFlags` and for the same reason. */
  viewerPreferences: MemberPreferencesSchema.optional(),
  /** The access requests waiting on this viewer, for the same reason again. */
  accessRequests: z.array(ConversationAccessRequestItemSchema).optional(),
}).superRefine((event, context) => {
  if (event.topics.length === 0 && event.sidebar === undefined) {
    context.addIssue({
      code: "custom",
      path: ["topics"],
      message: "must name at least one topic unless the event carries the sidebar",
    });
  }
  if (event.reason === "resume" && event.sidebar === undefined) {
    context.addIssue({
      code: "custom",
      path: ["sidebar"],
      message: "a resume exists to carry the sidebar",
    });
  }
  if (event.featureFlags !== undefined && event.sidebar === undefined) {
    context.addIssue({
      code: "custom",
      path: ["featureFlags"],
      message: "feature flags may appear only on the private subscribe answer",
    });
  }
});

/**
 * Ephemeral presence for the work stream foregrounded by this socket.
 *
 * The event is deliberately viewer-scoped rather than a workspace-wide map:
 * personal work-stream identities must not leak to members who cannot read
 * them, and the face pile needs only the room currently on screen. The current
 * user is omitted by the server.
 */
export const WorkspacePresenceEventSchema = z.strictObject({
  type: z.literal("workspace_presence"),
  occurredAt: TimestampSchema,
  workstreamId: WorkstreamIdSchema.nullable(),
  userIds: z.array(UserIdSchema),
});

/**
 * A purpose-bound socket ticket as the Worker issues it: where to connect, and
 * the single-use credential to present in `Sec-WebSocket-Protocol`.
 */
export const SocketTicketSchema = z.object({ url: WebSocketUrlSchema, ticket: z.string().min(1) });

/**
 * These people joined or left a Channel or a Breakout.
 *
 * Addressed rather than broadcast: a socket is told a person's id only when
 * its own user is that person or may act as them through an active
 * impersonation relationship. It names no conversation, so it discloses no
 * membership the receiver could not already read; a receiver that cares
 * rereads its own view. Outside the waterline and never replayed — a client
 * rereads on reconnect instead. Older clients ignore the unknown `type`.
 */
export const WorkspaceReachChangedEventSchema = z.strictObject({
  type: z.literal("workspace_reach_changed"),
  occurredAt: TimestampSchema,
  userIds: z.array(UserIdSchema).min(1),
});
export type WorkspaceReachChangedEvent = z.infer<typeof WorkspaceReachChangedEventSchema>;

/**
 * What a resource shows at its newest version: the fields a new version can
 * move, and nothing about how a conversation links it. A client merges it
 * over the resource it already holds, keeping that link's own fields.
 */
export const ResourceHeadSchema = z.strictObject({
  resourceId: IdSchema,
  version: z.number().int().positive(),
  title: z.string().min(1).max(300),
  mimeType: z.string().max(160).nullable(),
  updatedAt: TimestampSchema,
  contentAvailable: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
});
export type ResourceHead = z.infer<typeof ResourceHeadSchema>;

/**
 * These resources have a new version, of any type and from any producer, so
 * any preview open on one is stale.
 *
 * Addressed per socket: a resource is named only to a person who may open the
 * Main of a thread that links it, the same gate an artifact pin reads under.
 * An unlisted resource is never named.
 * Outside the waterline and never replayed: a client that was away reads each
 * resource's head when it next opens the conversation that holds it. Older
 * clients ignore the unknown `type`. `docs/websocket-architecture.md` owns it.
 */
export const WorkspaceResourceVersionsEventSchema = z.strictObject({
  type: z.literal("workspace_resource_versions"),
  occurredAt: TimestampSchema,
  resources: z.array(ResourceHeadSchema).min(1),
});
export type WorkspaceResourceVersionsEvent = z.infer<typeof WorkspaceResourceVersionsEventSchema>;

/**
 * User-specific flags sent outside the workspace waterline. Two people in one
 * WorkspaceDO can match different Flagship rules, so these values must never
 * ride the common `workspace_sync` event.
 */
export const WorkspaceFeatureFlagsEventSchema = z.strictObject({
  type: z.literal("workspace_feature_flags"),
  occurredAt: TimestampSchema,
  changedFlag: ProductFeatureFlagKeySchema.nullable(),
  flags: ClientFeatureFlagsSchema,
});

/**
 * One sidebar list and the version WorkspaceDO stamped on it.
 *
 * Sent whole rather than as a patch: a row the viewer can no longer see is
 * expressed by its absence, so archive and delete need no tombstone, and at
 * most 250 summaries there is nothing a diff would buy but a way to be wrong.
 *
 * `waterline` is per list, monotonic within WorkspaceDO, and advanced inside
 * the transaction of the write that earned it. Two counters rather than one
 * because the lists change independently, and one counter would let a note
 * write hide an automation update. It is the same number the opening
 * `workspace_sidebar` connect payload carries for that list, which is what lets
 * the payload and the pushes be ordered against each other instead of racing:
 * both land in one receiver that applies only a strictly greater version.
 *
 * The rows carry no per-row version of their own — unlike a work-stream row,
 * which is assembled from child objects over an unordered Queue and needs one
 * per field. Here the list is the unit, one authority produces it, and the
 * whole list is replaced or ignored together.
 */
export const WorkspaceSidebarListEventSchema = z.discriminatedUnion("list", [
  z.strictObject({
    type: z.literal("workspace_sidebar_list"),
    occurredAt: TimestampSchema,
    list: z.literal("automations"),
    waterline: z.number().int().positive(),
    items: z.array(AutomationSummarySchema).max(250),
  }),
  z.strictObject({
    type: z.literal("workspace_sidebar_list"),
    occurredAt: TimestampSchema,
    list: z.literal("notes"),
    waterline: z.number().int().positive(),
    items: z.array(z.unknown()).max(250).transform(() => [] as never[]),
    /**
     * The newest page only ever carries the newest page, so a reader who has
     * scrolled further needs to know whether this push is the whole list — in
     * which case it replaces what they hold — or just its head, in which case
     * it merges. `null` means the list ends here. Optional for the rolling
     * deployment; an older server sending none reads as the whole list, which
     * is what it was.
     */
    nextCursor: NoteCursorSchema.nullable().optional(),
  }),
]);

/**
 * The viewer's complete active and inactive Space state after a Space write.
 *
 * The shape the Project snapshot used, and for the same reasons: WorkspaceDO
 * owns both lists and their shared waterline, personal-Space visibility and
 * ordering are per viewer, and absence is the tombstone when somebody stops
 * being a participant. `spacesReady` travels with it because a write can be the write
 * that finishes the cutover, and a client holding `false` would otherwise keep
 * showing the opening state until it reconnected.
 */
export const WorkspaceSpaceSnapshotEventSchema = z.strictObject({
  type: z.literal("workspace_space_snapshot"),
  occurredAt: TimestampSchema,
  spaces: SpaceSnapshotSchema,
  /**
   * Every list this viewer has arranged by hand, in full.
   *
   * The whole ordering rather than the container that just moved, for the
   * reason the directories are whole: this is the one message a viewer's other
   * windows get, and a delta would make each of them keep a copy to apply it
   * to. Required here and optional on the connect payload, because a server
   * that sends this event is a server that has the ordering.
   */
  ordering: PersonalOrderSchema,
  /** All's Pinned order, beside `ordering` for the reason the sidebar payload gives. */
  pinnedOrder: PinnedOrderSchema.optional(),
  /** Every pin, beside `pinnedOrder` for the reason the sidebar payload gives. */
  pins: PinListSchema.optional(),
  artifactPins: ArtifactPinListSchema.optional(),
  channelStats: z.array(ChannelStatsSchema).optional(),
  spacesReady: z.boolean(),
});

/**
 * This person's own navigation state after a write only they made: their pin
 * list, or their read state in one Channel. Sent to that person's sockets
 * alone, so a second window follows a pin or a read without the whole Space
 * snapshot being rebuilt for every socket they have. Each field present
 * replaces what is held: `pins` and `artifactPins` each the whole list, each
 * `channelStats` row the row for its Channel. A client that does not know this event ignores it.
 */
export const WorkspaceNavigationStateEventSchema = z.strictObject({
  type: z.literal("workspace_navigation_state"),
  occurredAt: TimestampSchema,
  pins: PinListSchema.optional(),
  artifactPins: ArtifactPinListSchema.optional(),
  channelStats: z.array(ChannelStatsSchema).optional(),
});

/**
 * The Space dashboards whose page this viewer should read again.
 *
 * A nudge with the current aggregate: it carries no rows or version, only the
 * Spaces whose list of "conversations that need you" could have moved and the
 * new count for each. The dashboard re-reads the page it is holding; the
 * sidebar applies the count without rebuilding the whole Space directory.
 *
 * **Nothing durable stands behind it.** The list is re-read on mount, on
 * reconnect and on this event, so a nudge lost to a closing socket costs one
 * stale view until the next event or the next reconnect — which is cheaper to
 * reverse than a per-viewer counter written on every message in the
 * Organization. `docs/spaces.md` records why that trade was taken.
 *
 * The ids are the ones *this* viewer may see. A Space a person cannot see is
 * never named: a personal Space's id on somebody else's socket is the
 * existence of that Space leaking through a shared Channel.
 */
export const WorkspaceSpaceConversationsEventSchema = z.strictObject({
  type: z.literal("space_conversations_changed"),
  occurredAt: TimestampSchema,
  /**
   * At least one, because a nudge naming no Space asks for nothing. No upper
   * bound: a Channel may be in as many Spaces as somebody puts it in, and the
   * Organization has no number for that to trip over.
   */
  spaceIds: z.array(IdSchema).min(1),
  /** Current dashboard totals for the same viewer and the same named Spaces. */
  attentionCounts: z.array(z.strictObject({
    spaceId: SpaceIdSchema,
    count: z.number().int().nonnegative(),
  })).default([]),
  /**
   * Whether a thread entered or left one of these Channels, rather than a
   * thread already in one changing. Only a placement changes which threads a
   * person's Threads and Activity lists hold, so only a placement re-reads
   * them; a message in a thread re-reads the open Channel's feed alone.
   * Absent from a server that predates it, which a client reads as `true`.
   */
  placementChanged: z.boolean().optional(),
}).superRefine((event, context) => {
  const named = new Set(event.spaceIds);
  for (const [index, entry] of event.attentionCounts.entries()) {
    if (!named.has(entry.spaceId)) context.addIssue({
      code: "custom",
      path: ["attentionCounts", index, "spaceId"],
      message: "must name a Space in spaceIds",
    });
  }
});

/** A current state row pushed by WorkspaceDO after Queue ingestion. */
export const WorkspaceWorkstreamStateEventSchema = z.strictObject({
  type: z.literal("workspace_workstream_state"),
  occurredAt: TimestampSchema,
  workstreamId: IdSchema,
  stateVersion: WorkstreamStateVersionSchema,
  /** Null is a versioned visibility/archive tombstone for this viewer. */
  workstream: WorkstreamSchema.nullable(),
}).superRefine((event, context) => {
  if (event.workstream && event.workstream.id !== event.workstreamId) {
    context.addIssue({
      code: "custom",
      path: ["workstream", "id"],
      message: "must match workstreamId",
    });
  }
});

/**
 * The WorkstreamDO-owned common metadata plus the authenticated viewer overlay.
 * Transcript, tools, presence, and streaming output intentionally remain on
 * the selected SubstreamAgent feed.
 */
export const WorkstreamControlMetadataSchema = z.strictObject({
  appearance: WorkstreamAppearanceSchema.optional(),
  stateVersion: WorkstreamStateVersionSchema,
  /** Independent of workspace viewer/notification projection ordering. */
  privateChildrenWaterline: z.number().int().nonnegative().optional(),
  revision: z.number().int().nonnegative(),
  id: IdSchema,
  workspaceId: IdSchema,
  title: z.string().min(1).max(500),
  description: z.string().max(4_000),
  preview: z.string().max(1_000),
  emailAddress: z.string().email().max(254).nullable(),
  createdByUserId: IdSchema.nullable(),
  titleStatus: z.enum(["naming", "automatic", "settled"]),
  exactState: z.string().min(1).max(80),
  harnessStatus: HarnessStatusSchema,
  /**
   * Every running background agent in the work stream. Kept for desktop
   * clients released before `backgroundAgentCounts`; drop it once the oldest
   * supported desktop reads that field instead.
   */
  backgroundAgentCount: z.number().int().nonnegative().optional(),
  /**
   * Running background agents by the conversation they work for, keyed by
   * substream id. A conversation with none is absent. Omission of the whole
   * field means this snapshot does not know the current counts.
   */
  backgroundAgentCounts: WorkstreamBackgroundAgentCountsSchema.optional(),
  latestAttentionSequenceNumber: z.number().int().nonnegative(),
  unreadTrackingStartSequenceNumber: z.number().int().nonnegative(),
  lastActivityAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  scope: ScopeSchema,
  systemKind: z.enum(["digest"]).nullable(),
  nextPendingWakeup: z.object({
    dueAt: TimestampSchema,
    promptPreview: z.string().min(1).max(WORKSTREAM_WAKEUP_PROMPT_PREVIEW_LENGTH + 1),
  }).nullable(),
  nextTerminalActionAt: TimestampSchema.nullable(),
  /** Ready non-main conversations this authenticated viewer may open. */
  privateChildren: z.array(WorkstreamPrivateChildSchema).optional(),
  viewer: z.strictObject({
    isParticipant: z.boolean(),
    listable: z.boolean(),
    unreadCount: z.number().int().nonnegative(),
    youAreMentioned: z.boolean(),
    /** See `WorkstreamSchema.unseen`. False for anyone not in the room. */
    unseen: z.boolean().default(false),
    readThroughSequenceNumber: z.number().int().nonnegative(),
    manualUnreadFromSequenceNumber: z.number().int().nonnegative().nullable(),
    manualUnreadGeneration: z.number().int().nonnegative(),
    latestMentionSequenceNumber: z.number().int().nonnegative(),
  }),
});

export const WorkstreamControlSocketClientEventSchema = z.strictObject({
  type: z.literal("subscribe"),
});

export const WorkstreamControlSocketEventSchema = z.strictObject({
  type: z.literal("workstream_metadata"),
  occurredAt: TimestampSchema,
  metadata: WorkstreamControlMetadataSchema,
});

export type WorkspaceSyncTopic = z.infer<typeof WorkspaceSyncTopicSchema>;
export type WorkspaceSocketClientEvent = z.infer<typeof WorkspaceSocketClientEventSchema>;
export type WorkspaceSocketSyncEvent = z.infer<typeof WorkspaceSocketSyncEventSchema>;
export type WorkspacePresenceEvent = z.infer<typeof WorkspacePresenceEventSchema>;
export type WorkspaceFeatureFlagsEvent = z.infer<typeof WorkspaceFeatureFlagsEventSchema>;
export type WorkspaceWorkstreamPageEvent = z.infer<typeof WorkspaceWorkstreamPageEventSchema>;
export type WorkspaceSidebar = z.infer<typeof WorkspaceSidebarSchema>;
export type WorkspaceSidebarListEvent = z.infer<typeof WorkspaceSidebarListEventSchema>;
export type WorkspaceSpaceSnapshotEvent = z.infer<typeof WorkspaceSpaceSnapshotEventSchema>;
export type WorkspaceNavigationStateEvent = z.infer<typeof WorkspaceNavigationStateEventSchema>;
export type WorkspaceSpaceConversationsEvent = z.infer<typeof WorkspaceSpaceConversationsEventSchema>;
export type WorkspaceWorkstreamStateEvent = z.infer<typeof WorkspaceWorkstreamStateEventSchema>;
export type WorkstreamStateVersion = z.infer<typeof WorkstreamStateVersionSchema>;
export type WorkstreamControlMetadata = z.infer<typeof WorkstreamControlMetadataSchema>;
export type WorkstreamControlSocketEvent = z.infer<typeof WorkstreamControlSocketEventSchema>;

/**
 * A direct response to one client command. It is deliberately outside the room
 * event sequence: the canonical transcript-turn upsert is replayable and
 * broadcast, while this receipt is private to the socket that submitted it.
 * Reconnecting clients resend the same `clientMessageId` and receive the same
 * private receipt through the command's idempotent write path.
 */
export const WorkstreamMessageDeliveryStateSchema = z.enum(["canonical", "pending"]);
export const WorkstreamMessageAdmissionReceiptSchema = z.strictObject({
  turn: z.strictObject({
    turnId: TranscriptTurnIdSchema,
    clientMessageId: z.string().min(1).max(120),
    createdAt: TimestampSchema,
  }),
  deliveryState: WorkstreamMessageDeliveryStateSchema,
});

const WorkstreamSocketCommandErrorSchema = z.strictObject({
  status: z.number().int().min(0).max(599),
  code: z.string().min(1).max(160),
  message: z.string().min(1).max(1_000),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const WorkstreamSocketCommandResultSchema = z.union([
  z.strictObject({ type: z.literal("client_command_succeeded"), command: z.literal("set_workstream_appearance"), operationId: IdSchema }),
  z.strictObject({
    type: z.literal("client_command_succeeded"),
    command: z.literal("create_message"),
    operationId: IdSchema,
    clientMessageId: z.string().min(1).max(120),
    ...WorkstreamMessageAdmissionReceiptSchema.shape,
  }),
  z.strictObject({
    type: z.literal("client_command_succeeded"),
    command: z.literal("answer_elicitation"),
    operationId: IdSchema,
    elicitation: ElicitationSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("client_command_succeeded"),
    command: z.literal("reorder_pending_inputs"),
    operationId: IdSchema,
    ...ReorderPendingLoopInputsResultSchema.shape,
  }),
  z.strictObject({
    type: z.literal("client_command_succeeded"),
    command: z.literal("stop_harness"),
    operationId: IdSchema,
  }),
  z.strictObject({
    type: z.literal("client_command_succeeded"),
    command: z.literal("retry_harness"),
    operationId: IdSchema,
    harnessRunId: IdSchema,
  }),
  z.strictObject({
    type: z.literal("client_command_failed"),
    command: SubstreamSocketMutationTypeSchema,
    operationId: IdSchema,
    clientMessageId: z.string().min(1).max(120).optional(),
    error: WorkstreamSocketCommandErrorSchema,
  }),
]);

const ServerEventBaseSchema = z.object({
  sequence: z.number().int().nonnegative(),
  occurredAt: TimestampSchema
});
const StreamEventBaseSchema = ServerEventBaseSchema.extend({
  /** Stable identity for one model turn, across retries and route fallbacks. */
  turnId: TranscriptTurnIdSchema,
  /** Canonical position reserved before the provider request begins. */
  transcriptSequence: z.number().int().positive(),
  /** Increments whenever a turn restarts on the same or a fallback route. */
  epoch: z.number().int().nonnegative(),
  /** Monotonic within one turn epoch; distinct from the room event sequence. */
  streamSeq: z.number().int().nonnegative()
});
/**
 * The accumulated assistant text a room can hand to somebody who subscribes
 * after the stream began. `turnStartOffset` identifies the prefix that survives
 * a retry without storing that prefix twice in Durable Object storage.
 */
const ActiveStreamCheckpointBaseSchema = z.object({
  /** Transient identity for one run's streamed output; never a transcript turn. */
  streamId: IdSchema,
  harnessRunId: IdSchema,
  turnId: TranscriptTurnIdSchema,
  epoch: z.number().int().nonnegative(),
  streamSeq: z.number().int().nonnegative(),
  seenTurnIds: z.array(TranscriptTurnIdSchema),
  text: z.string(),
  turnStartOffset: z.number().int().nonnegative(),
  roomSequence: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
}).refine((checkpoint) => checkpoint.turnStartOffset <= checkpoint.text.length, {
  message: "Turn start must fall within the accumulated stream text",
  path: ["turnStartOffset"],
});
/** Workstream streams always occupy a pre-reserved canonical position. */
export const ActiveStreamCheckpointSchema = ActiveStreamCheckpointBaseSchema.and(z.object({
  transcriptSequence: z.number().int().positive(),
}));
export const ActiveStreamCheckpointsSchema = z.array(ActiveStreamCheckpointSchema).max(1);

/** The one context-compaction operation currently owned by an agent DO. */
export const AgentCompactionStateSchema = z.strictObject({
  harnessRunId: IdSchema,
  attemptId: IdSchema,
  compactionIndex: z.number().int().positive(),
  trigger: z.enum(["manual", "auto"]),
  startedAt: TimestampSchema,
});
export type AgentCompactionState = z.infer<typeof AgentCompactionStateSchema>;

/**
 * The close code the work-stream room uses when it disconnects a socket whose
 * reader may no longer see the work stream.
 *
 * It is `1008` (policy violation) rather than an application code because the
 * close frame is the whole message — there is no event body to carry a reason
 * to somebody who is no longer allowed one. The client distinguishes it from
 * every other close: an ordinary close reconnects, this one must not, because
 * the reconnect would 404 forever with a transcript still on screen.
 *
 * The room deliberately uses `1011` when it cannot *establish* who may stay, so
 * that case still reconnects and is re-authorized rather than dead-ending.
 */
export const WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE = 1008;

/**
 * Application close codes for failures on an admitted workspace command
 * socket. They deliberately do not reuse `1008`: released desktops reserve
 * that code on the workspace command channel for a real access revocation and
 * stop reconnecting when they see it, so using it there for a malformed frame
 * or expired session tells the member a permission was withdrawn when no such
 * decision occurred.
 */
export const WORKSPACE_SOCKET_INVALID_MESSAGE_CODE = 4400;
export const WORKSPACE_SOCKET_SESSION_INACTIVE_CODE = 4401;

/** Transient status for one provider attempt within an active conversation run. */
export const InferenceDelayStateSchema = z.object({
  harnessRunId: IdSchema,
  parentAttemptId: IdSchema.optional(),
  executionId: IdSchema,
  attemptId: IdSchema,
  inferenceRequestId: IdSchema,
  turnId: z.string().min(1),
});
export type InferenceDelayState = z.infer<typeof InferenceDelayStateSchema>;

export const ServerSocketEventSchema = z.discriminatedUnion("type", [
  ServerEventBaseSchema.extend({
    type: z.literal("snapshot"),
    reason: z.enum(["initial", "reconciliation", "history_unavailable"]),
    workstream: WorkstreamDetailSchema,
    transcript: WorkstreamTranscriptSnapshotSchema,
    /**
     * Pending overlays are split into follow-up frames only when their complete
     * server-authoritative set would exceed one WebSocket frame. Zero means the
     * transcript snapshot already carries the complete set.
     */
    pendingInputChunkCount: z.number().int().nonnegative(),
    initialContextChunkCount: z.number().int().nonnegative().optional(),
    activeStreams: ActiveStreamCheckpointsSchema.default([]),
    activeCompaction: AgentCompactionStateSchema.nullable().default(null),
    activeInferenceDelays: z.array(InferenceDelayStateSchema).default([]),
    /**
     * The open suggestions on the newest turns, for a build that draws them.
     * Optional, and stripped by `safeParseSocketEvent` on a build that does
     * not know the key, so no contract gate is needed for the snapshot.
     */
    suggestions: z.array(ConversationSuggestionSchema).optional(),
  }).strict(),
  ServerEventBaseSchema.extend({
    type: z.literal("initial_context_snapshot_chunk"),
    snapshotId: z.string().min(1),
    chunkIndex: z.number().int().nonnegative(),
    chunkCount: z.number().int().positive(),
    json: z.string(),
  }).strict(),
  ServerEventBaseSchema.extend({
    type: z.literal("pending_inputs_snapshot_chunk"),
    snapshotId: z.string().min(1),
    chunkIndex: z.number().int().nonnegative(),
    chunkCount: z.number().int().positive(),
    inputs: z.array(PendingTranscriptInputSchema).min(1),
  }).strict(),
  ServerEventBaseSchema.extend({ type: z.literal("presence_changed"), viewers: z.array(ViewerSchema) }),
  ServerEventBaseSchema.extend({
    type: z.literal("transcript_turn_upserted"),
    turn: TranscriptTurnSchema,
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("loop_input_upserted"),
    input: PendingTranscriptInputSchema,
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("loop_input_removed"),
    inputId: z.string().min(1),
    outcome: z.enum(["delivered", "cancelled"]),
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("transcript_activity_upserted"),
    activity: TranscriptActivitySchema,
    snapshotAtUtc: z.string().datetime({ offset: true }),
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("transcript_range"),
    requestId: IdSchema,
    snapshotId: IdSchema,
    result: TranscriptRangeResultSchema,
  }),
  /**
   * The title changed — a person renamed the work stream, or Rally named it.
   *
   * `icon` rides along only when a naming pass chose one, which is the only
   * writer of an icon nobody picked; it is absent on a rename by a person, who
   * changed no icon. A client applies it to the sidebar row and leaves the
   * header to the versioned projection, because the cached detail behind the
   * header is what retires the appearance picker's pending preview.
   */
  ServerEventBaseSchema.extend({
    type: z.literal("workstream_renamed"),
    title: z.string().min(1).max(180),
    titleStatus: z.enum(["automatic", "settled"]),
    icon: WorkstreamIconKeySchema.optional(),
  }),
  /**
   * Who may read this work stream changed. Everyone still in the room learns
   * the new state so the lock on their sidebar row and the header they are
   * reading agree with it; those the change just excluded are disconnected by
   * the room rather than told.
   */
  ServerEventBaseSchema.extend({
    type: z.literal("workstream_scope_changed"),
    scope: ScopeSchema
  }),
  /**
   * A conversation suggestion was opened, filled with its draft, or resolved.
   * The row's full state travels each time, so a client replaces what it
   * holds for that suggestion id. A build that does not know the type ignores
   * the frame, which is why the event needs no contract gate.
   */
  ServerEventBaseSchema.extend({
    type: z.literal("conversation_suggestion_changed"),
    suggestion: ConversationSuggestionSchema,
  }),
  StreamEventBaseSchema.extend({
    type: z.literal("stream_started"),
    streamId: IdSchema,
    harnessRunId: IdSchema,
    reset: z.literal(false)
  }),
  StreamEventBaseSchema.extend({
    type: z.literal("stream_delta"),
    streamId: IdSchema,
    /** Present on new publishers; optional while older regional Workers drain. */
    harnessRunId: IdSchema.optional(),
    delta: z.string(),
    /** Replaces text from the prior attempt instead of concatenating it. */
    reset: z.boolean()
  }),
  ServerEventBaseSchema.extend({ type: z.literal("stream_completed"), streamId: IdSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("harness_status_changed"), status: HarnessStatusSchema }),
  ServerEventBaseSchema.extend({
    type: z.literal("inference_delay_changed"),
    ...InferenceDelayStateSchema.shape,
    active: z.boolean(),
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("compaction_started"),
    compaction: AgentCompactionStateSchema,
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("compaction_finished"),
    harnessRunId: IdSchema,
    attemptId: IdSchema,
    compactionIndex: z.number().int().positive(),
    outcome: z.enum(["completed", "failed"]),
  }),
  ServerEventBaseSchema.extend({ type: z.literal("tool_started"), invocation: ToolInvocationSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("tool_completed"), invocation: ToolInvocationSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("tool_failed"), invocation: ToolInvocationSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("elicitation_created"), elicitation: ElicitationSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("elicitation_answered"), elicitation: ElicitationSchema }),
  /**
   * Work a running tool asks of the person's desktop. Sent when the tool asks,
   * and again to a socket that subscribes while it is still unanswered.
   */
  ServerEventBaseSchema.extend({ type: z.literal("desktop_action_requested"), request: DesktopActionRequestSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("participant_added"), participant: ParticipantSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("participant_removed"), userId: IdSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("resource_attached"), resource: WorkstreamResourceSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("resource_updated"), resource: WorkstreamResourceSchema }),
  // Parse-only rollout compatibility for events emitted by the previous
  // Worker while a newer desktop is already running. No current producer or
  // consumer uses the payload.
  ServerEventBaseSchema.extend({ type: z.literal("activity_suggestion_created"), suggestion: z.unknown() }),
  ServerEventBaseSchema.extend({ type: z.literal("activity_suggestion_resolved"), suggestion: z.unknown() }),
  ServerEventBaseSchema.extend({
    type: z.literal("resync_required"),
    reason: z.enum(["history_unavailable", "snapshot_expired", "sequence_ahead"]),
    latestSequence: z.number().int().nonnegative(),
    /** Preserves an in-flight response while canonical REST state is refreshed. */
    activeStreams: ActiveStreamCheckpointsSchema.default([]),
    /** Preserves the explicit compaction indicator across replay-window loss. */
    activeCompaction: AgentCompactionStateSchema.nullable().default(null),
    activeInferenceDelays: z.array(InferenceDelayStateSchema).default([]),
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    /**
     * The client request this error answers, when it answers one.
     *
     * Most errors are unsolicited: they describe the socket rather than a
     * question somebody asked on it. A refusal of a correlated request is
     * different — the caller is holding a promise that nothing else will
     * settle, and without this it waits out a client-side timeout and reports
     * the timeout instead of the reason. Null keeps every existing producer's
     * frame valid, and an older Worker's uncorrelated frame still parses.
     */
    requestId: IdSchema.nullable().default(null),
  })
]);

/**
 * Set on a normalized activity's metadata when the polling stream that produced
 * it is not digestible, so the withholding survives the queue and the
 * `activities` row into the moment the activity log is written.
 *
 * A metadata key rather than a column because it is a stream's veto over its own
 * output, not a property of the activity that any other surface reads: nothing
 * queries on it, and the event type remains the authority on what a digest may
 * contain. The leading underscore is the same convention the activity
 * consumer's processing-claim keys already use for host-owned metadata.
 */
export const ACTIVITY_STREAM_NOT_DIGESTIBLE_METADATA_KEY = "_streamNotDigestible";

/**
 * A place inside a provider that a work stream can be started from — a Slack
 * thread, a Linear issue, a GitHub pull request.
 *
 * This is the connector half of a work stream's origin attachment, and it
 * deliberately names no connection and no provider: a connector knows *which
 * object*, and only the host knows which installed credential it was reached
 * through. Keeping those apart is what stops an adapter from being able to
 * describe an origin against somebody else's connection.
 * See `docs/workstream-origin-attachments.md`.
 */
export const ConnectorOriginResourceSchema = z.strictObject({
  /** Must be one the connector's manifest declares in `resourceTypes`. */
  resourceType: z.string().min(1).max(80),
  providerResourceId: z.string().min(1).max(500),
  title: z.string().min(1).max(300),
  canonicalUrl: HttpUrlSchema.nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const NormalizedActivitySchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  region: RegionSchema,
  connectionId: IdSchema,
  connectionScope: ScopeSchema,
  connectionOwnerUserId: IdSchema.nullable(),
  provider: z.string().min(1),
  providerEventId: z.string().min(1),
  eventType: z.string().min(1),
  resourceType: z.string().nullable(),
  providerResourceId: z.string().nullable(),
  actor: z.record(z.string(), z.unknown()),
  subject: z.record(z.string(), z.unknown()),
  occurredAt: TimestampSchema,
  receivedAt: TimestampSchema,
  title: z.string().min(1),
  summary: z.string(),
  textSnippet: z.string().max(4000),
  payloadRef: z.string().nullable(),
  visibility: z.record(z.string(), z.unknown()),
  targetUserIds: z.array(IdSchema),
  entityKeys: z.array(z.string()),
  dedupeKey: z.string().min(1),
  rawContentHash: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  /**
   * The occurrence this activity reports, when more than one delivery can
   * report it: a Granola note arrives as `note.access_granted` when it is
   * shared and as `note.generated` when its summary is written. An automation
   * admits the event under this key, once, instead of under the event id.
   * Adapter code sets it, namespaced by provider; it never comes from a
   * provider payload, and the workspace store drops a same-named key found in
   * `metadata` so no caller can stand one in.
   */
  occurrenceKey: z.string().min(1).optional(),
  externalPeople: ExternalPeopleSchema.optional()
});

export const ActivityQueueMessageSchema = z.object({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  activityId: IdSchema,
  attempt: z.number().int().min(0).max(5).default(0)
});

export const SlackIngressQueueMessageSchema = z.object({
  kind: z.literal("slack_ingress"),
  region: RegionSchema,
  workspaceId: IdSchema,
  jobId: z.string().min(1),
});

export const ExecutionPrincipalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), userId: UserIdSchema }),
  z.object({ type: z.literal("workspace"), workspaceId: WorkspaceIdSchema })
]);

export const SlackOriginAttachmentSchema = z.strictObject({
  id: z.string().min(1).max(255).nullable(),
  name: z.string().min(1).max(500),
  title: z.string().max(500).nullable(),
  mimeType: z.string().max(255).nullable(),
  fileType: z.string().max(120).nullable(),
  permalink: httpUrlSchema(2000).nullable()
});

export const SlackOriginNearbyMessageSchema = z.strictObject({
  timestamp: z.string().min(1).max(80),
  userId: z.string().min(1).max(255).nullable(),
  text: z.string().max(2000),
  attachments: z.array(SlackOriginAttachmentSchema).max(10)
});

export const SlackOriginContextSchema = z.strictObject({
  teamId: z.string().min(1).max(255),
  /** Slack member whose message triggered this run; server-owned delivery routing metadata. */
  actorSlackUserId: z.string().min(1).max(255).optional(),
  channelId: z.string().min(1).max(255).nullable(),
  channelName: z.string().min(1).max(255).nullable(),
  threadTs: z.string().min(1).max(80).nullable(),
  /** The message itself, when it reached Rally through a bound thread. */
  messageTs: z.string().min(1).max(80).optional(),
  /** A link back to that message, built from the team, channel and timestamp. */
  permalink: httpsUrlSchema(2000).optional(),
  /**
   * The message this run's status reaction sits on; see "The status reaction"
   * in docs/slack-integration.md. Only what the event itself fixes: this rides
   * in the message's admission identity, so a value a retry could answer
   * differently would make the retry a conflict.
   */
  reactionAnchor: z.strictObject({
    channelId: z.string().min(1).max(255),
    messageTs: z.string().min(1).max(80),
  }).optional(),
  invocationType: z.enum(["app_mention", "direct_message", "slash_command", "shortcut"]),
  channelType: z.enum(["public", "private", "im", "unknown"]),
  matchedAvalonUserId: IdSchema.nullable(),
  nearbyMessagesStatus: z.enum(["available", "unavailable", "not_applicable"]),
  nearbyMessages: z.array(SlackOriginNearbyMessageSchema).max(8),
  attachments: z.array(SlackOriginAttachmentSchema).max(10),
  appContext: z.strictObject({
    entities: z.array(z.strictObject({
      type: z.string().min(1).max(255),
      value: z.string().min(1).max(1000),
      teamId: z.string().min(1).max(255).nullable()
    })).max(32)
  }).nullable().optional()
});

/**
 * Short-lived Slack authorization attached to a user-initiated Events API
 * delivery. This is runtime-only credential material: it must never be
 * rendered into model instructions, messages, tool arguments, or logs.
 */
export const SlackSearchAuthorizationSchema = z.strictObject({
  actionToken: z.string().min(1).max(4096)
});

export const WorkstreamWorkflowInputSchema = z.object({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  /**
   * The conversation's parent: a work stream or an automation. `parentId` is
   * what every object port and the object name are keyed on; the parent's
   * substream `0` holds the product rows for every substream under it.
   */
  parentKind: ConversationParentKindSchema,
  parentId: IdSchema,
  /** External child identity. Existing producers and the main feed use `0`. */
  substreamId: SubstreamIdSchema.optional(),
  /** Stable identity of the one persistent loop owned by this substream. */
  loopId: z.string().min(1).max(300),
  /** Subordinate execution receipt. A message never owns or creates a loop. */
  harnessRunId: HarnessRunIdSchema,
  triggerMessageId: IdSchema.nullable(),
  /**
   * The newest message this run may see, when that is not the trigger.
   *
   * The trigger doubles as the transcript's upper bound, which is right for a
   * run a message started and wrong for a `retry`: the failed run's trigger has
   * to stay the trigger — it is what admits a suggested-work brief or an
   * inbound email to the model — while the replay still needs to see anything
   * said since, including a correction that started no run of its own. Resolved
   * at launch rather than at projection time so a replayed attempt reads the
   * same window. Optional rather than nullable so every existing producer keeps
   * parsing unchanged.
   *
   * A transcript turn id, not an entity id — hence `TranscriptTurnIdSchema` and
   * not `IdSchema` like the trigger above it. A trigger is always an input and
   * carries a UUID; the *newest* turn is whatever the transcript ends with, and
   * an assistant turn's id is `<loopId>:turn:<ordinal>`. See
   * {@link TranscriptTurnIdSchema} for the rule, and the 2026-09-03 changelog
   * entry in `docs/workstream-durable-object.md` for what typing it as a UUID
   * cost.
   */
  transcriptFenceMessageId: TranscriptTurnIdSchema.nullable().optional(),
  /**
   * Set on a run under an automation. A reference, not a copy: the run reads
   * its definition from the automation by revision when it starts.
   */
  automationRun: AutomationRunReferenceV1Schema.optional(),
  /**
   * Set beside `automationRun` when input to a Sidekick run child continued
   * that run, rather than the Sidekick's schedule or trigger starting it.
   * Optional so every existing producer keeps parsing unchanged;
   * `docs/automation-lifecycle.md` owns it.
   *
   * `stopGeneration` is the Sidekick's stop counter when `continueRun`
   * approved the continuation, which the run authority check fences a
   * `stopped` run row against. `senderName` and `source` are what the host-rendered continuation
   * note tells the model: who replied, and whether in a bound provider thread
   * or in the run itself.
   */
  automationContinuation: z.strictObject({
    stopGeneration: z.number().int().nonnegative(),
    senderName: z.string().min(1).max(200),
    /** The member who sent the input, when a member did: who asked for this turn. */
    senderUserId: UserIdSchema.optional(),
    source: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("run") }),
      z.strictObject({ kind: z.literal("provider_thread"), provider: z.string().min(1).max(100) }),
    ]),
  }).optional(),
  /** The received agent exchange supplies discovery scope and the ordinary reply reference. */
  agentExchange: AgentExchangeSchema.optional(),
  /** Host-derived conversation kind; not a model-selectable execution option. */
  backgroundAgent: z.boolean().optional(),
  activityId: IdSchema.nullable(),
  /**
   * Set when the workspace scheduler started this run from a due wake-up. The
   * run reads the wake-up's prompt as its trigger. Optional rather than
   * nullable so every existing producer keeps parsing unchanged.
   */
  scheduledWakeupId: IdSchema.optional(),
  executionPrincipal: ExecutionPrincipalSchema,
  /** Server-injected correlation for a user-started semantic run journey. */
  telemetryOperationId: IdSchema.optional(),
  /** Regional user record that owns the correlated run; never accepted from the client body. */
  telemetrySubjectUserId: IdSchema.optional(),
  /** Worker receipt boundary used to measure admission-to-provider dispatch. */
  telemetryRequestReceivedAt: z.number().int().nonnegative().optional(),
  /** Stable journey name for latency SLO aggregation. */
  telemetryJourney: z.enum(["workstream_create", "substream_create", "message_send"]).optional(),
  slackOrigin: SlackOriginContextSchema.optional(),
  slackSearchAuthorization: SlackSearchAuthorizationSchema.optional(),
  /**
   * Set on a run a demo seed started. The harness answers this run's provider
   * requests from the seed's turn instead of reaching OpenRouter, and nothing
   * else about the run differs. Carried from the message's authorization into
   * the execution context at activation, and from an opening message's context
   * at initialize. A run an elicitation answer resumes is built from the answer,
   * not from this context, so it is never seeded. Optional so every existing
   * producer keeps parsing unchanged; `docs/demo-workspaces.md` owns it.
   */
  seed: DemoSeedSchema.optional(),
  reason: z.string().min(1).max(500)
});
export const ConnectorPollWorkflowInputSchema = z.object({
  region: RegionSchema,
  workspaceId: IdSchema,
  connectionId: IdSchema,
  pollScheduleId: IdSchema
});

export const AddressingClassificationSchema = z.object({
  classification: z.enum(["agent_action", "human_only", "both", "uncertain"]),
  confidence: z.number().min(0).max(1),
  rationaleCode: z.enum([
    "imperative",
    "question",
    "connector_mention",
    "rally_reference",
    "active_task",
    "elicitation_answer",
    "human_coordination",
    "social_acknowledgement",
    "insufficient_signal"
  ])
});

/**
 * How long a work stream may report that it is being named.
 *
 * Naming takes about a second, so a work stream still saying `naming` well
 * after it was created is one whose background pass never finished — the
 * isolate went away before it could settle — and its provisional title is now
 * its title. Both sides of the wire apply this: the API stops *reporting*
 * `naming` past the grace, and a client applies it to what it already holds,
 * because a rename event that was never delivered leaves a client with a row no
 * read will correct. Shared here so the two cannot drift apart and leave a
 * skeleton pulsing on a surface whose backstop expired somewhere else.
 */
export const WORKSTREAM_NAMING_GRACE_MS = 60_000;

/**
 * The ceiling a generated work-stream name has to parse under — deliberately
 * far above the length the prompt asks for. It exists to stop a model that
 * answered the request instead of naming it, not to be aimed at: an answer
 * between the target and this is trimmed to a whole word by the naming service,
 * where rejecting it would leave the work stream unnamed.
 *
 * It is also the `maxLength` the naming request advertises, and that is the
 * load-bearing reason it must stay above the target rather than tracking it.
 * The request goes out `strict: true`, so a provider that enforces `maxLength`
 * stops generating at exactly that character — mid-word, at a length the naming
 * service cannot tell apart from a name that simply fit. The target belongs in
 * the prompt, which can ask for a whole name of that length; a hard decoding
 * bound at the same number can only chop one.
 */
export const WORKSTREAM_NAME_RESULT_MAX_LENGTH = 80;

/**
 * One generated work-stream name and the icon chosen with it, the name bounded
 * well under the 180 characters a title may hold.
 *
 * The icon falls back rather than failing: an answer whose icon is missing or
 * off the catalog parses as a name with no icon, and the work stream keeps the
 * generated mark it already had. The two are asked for in one call because they
 * describe the same thing, but the name is the load-bearing half — it is on
 * screen behind a skeleton — and an icon a provider spelled wrong must not cost
 * the work stream its name as well.
 *
 * The summary, asked for only on a first pass over a description derived from
 * the opening message, falls back the same way: a missing or malformed one
 * leaves that description standing and costs nothing else.
 */
export const WorkstreamNameResultSchema = z.object({
  title: z.string().trim().min(1).max(WORKSTREAM_NAME_RESULT_MAX_LENGTH),
  icon: PickableWorkstreamIconKeySchema.nullish().catch(null),
  summary: z.string().trim().min(1).nullish().catch(null),
});

export const ToolDefinitionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  /** Authored pagination only. Never accepted from remote MCP declarations. */
  pagination: z.object({ cursorParameter: z.string().min(1), sourceOnly: z.boolean().optional() }).optional(),
  /**
   * Exact provider-owned operation identity behind a normalized dynamic tool
   * name. Hosts use this only at execution; it is never model-visible.
   */
  providerOperationName: z.string().min(1).max(200).optional(),
  description: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
  capability: z.string().min(1),
  mode: z.enum(["read", "write"]),
  idempotency: z.enum(["safe", "provider_key", "record_before_execute"]),
  /** Advisory only: consider background execution; does not change dispatch or authority. */
  longRunning: z.boolean().optional(),
  /** Optional per-tool ceiling. The host still applies its overall run limit. */
  timeoutMs: z.number().int().positive().max(1_050_000).optional()
});

/**
 * Connector surfaces are composable. A provider such as Linear can expose its
 * ordinary resources and tools while also hosting Avalon as a native agent.
 * Legacy manifests omit this field and normalize to the resource surface.
 */
export const ConnectorSurfaceSchema = z.enum(["resource", "native_agent", "messaging_agent"]);

export const NativeAgentInvocationModeSchema = z.enum([
  "delegation",
  "mention",
  "follow_up"
]);

export const NativeAgentActivityKindSchema = z.enum([
  "thought",
  "action",
  "elicitation",
  "response",
  "error"
]);

export const ConnectorSurfaceMaturitySchema = z.enum(["stable", "preview"]);
export const ConnectorSurfaceRuntimeStatusSchema = z.enum(["protocol_only", "operational"]);
export const NativeAgentSessionOwnershipSchema = z.enum([
  "single_connection_per_provider_account",
  "connection_scoped"
]);

export const NativeAgentSurfaceSchema = z.object({
  capability: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  invocationModes: z.array(NativeAgentInvocationModeSchema).min(1),
  activityKinds: z.array(NativeAgentActivityKindSchema).min(1),
  supportsCancellation: z.boolean(),
  supportsExternalLinks: z.boolean(),
  supportsPlans: z.boolean(),
  supportsProactiveSessions: z.boolean().default(false),
  maturity: ConnectorSurfaceMaturitySchema.default("stable"),
  /** Protocol support may ship before the coordinating runtime is safe to enable. */
  runtimeStatus: ConnectorSurfaceRuntimeStatusSchema,
  /** How provider-native sessions select one authorized Avalon connection. */
  sessionOwnership: NativeAgentSessionOwnershipSchema,
  /** Maximum time the provider allows before the signed webhook is acknowledged. */
  webhookResponseDeadlineMs: z.number().int().positive().max(60_000).optional(),
  /** Maximum time before the connector must publish activity or an external URL. */
  sessionAcknowledgementDeadlineMs: z.number().int().positive().max(60_000).optional()
});

/**
 * A provider-native conversational surface whose transport is owned by the
 * connector control plane. Unlike ordinary tools, inbound invocations and
 * streamed responses are never exposed to the model as callable operations.
 */
export const MessagingAgentSurfaceSchema = z.object({
  capability: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  invocationModes: z.array(z.enum(["direct_message", "mention", "shortcut", "command", "follow_up"])).min(1),
  supportsStreaming: z.boolean(),
  supportsThreads: z.boolean(),
  supportsAppHome: z.boolean(),
  supportsModals: z.boolean(),
  supportsUnfurling: z.boolean(),
  supportsProactiveDelivery: z.boolean(),
  maturity: ConnectorSurfaceMaturitySchema.default("stable"),
  runtimeStatus: ConnectorSurfaceRuntimeStatusSchema,
  webhookResponseDeadlineMs: z.number().int().positive().max(60_000),
});

export const ConnectorCapabilityKindSchema = z.enum(["tool", "host", "native_agent", "messaging_agent"]);

/**
 * Authorization is capability based, including capabilities that do not map
 * to an agent tool. This lets native provider identities participate in OAuth
 * grants without inventing a callable tool solely to make them selectable.
 */
export const ConnectorCapabilitySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  kind: ConnectorCapabilityKindSchema,
  description: z.string().min(1).optional()
});

export const ConnectorActivityFilterValueTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "string_array",
  "person_id",
  "person_id_array",
]);

/**
 * The operators a filter field offers when its manifest names none.
 *
 * Old manifests described equality-only filters, and `equals` stays the
 * default for the scalar types. It was also the default for the array types,
 * whose predicate leaf accepts only the set operators, so a field such as
 * Granola's `changedFields` or Notion's `authorPersonIds` could be declared
 * and inspected but never used in a rule: every operator the leaf allowed was
 * one the field did not declare. The default follows the type.
 */
export function defaultConnectorActivityFilterOperators(
  valueType: z.infer<typeof ConnectorActivityFilterValueTypeSchema>,
): ["equals"] | ["has_any", "has_all", "has_none"] {
  return valueType === "string_array" || valueType === "person_id_array"
    ? ["has_any", "has_all", "has_none"]
    : ["equals"];
}

export const ConnectorActivityFilterFieldSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/),
  label: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  valueType: ConnectorActivityFilterValueTypeSchema,
  /** Absent means the type's default, see {@link defaultConnectorActivityFilterOperators}. */
  operators: z.array(z.enum([
    "equals",
    "not_equals",
    "contains",
    "starts_with",
    "ends_with",
    "in",
    "not_in",
    "greater_than",
    "less_than",
    "greater_than_or_equals",
    "less_than_or_equals",
    "has",
    "has_any",
    "has_all",
    "has_none",
    "exists",
    "not_exists",
  ])).min(1).optional(),
  sensitive: z.boolean().default(false),
}).transform((field) => ({
  ...field,
  operators: field.operators ?? defaultConnectorActivityFilterOperators(field.valueType),
}));

export const ConnectorActivityTriggerDescriptorSchema = z.strictObject({
  eventType: z.string().min(1).max(200),
  label: z.string().min(1).max(160),
  description: z.string().min(1).max(800),
  /** Authoring-only families. Accepted rules expand these to exact event types. */
  eventFamilies: z.array(z.string().min(1).max(200)).default([]),
  filterFields: z.array(ConnectorActivityFilterFieldSchema).default([]),
  /** The payload's own keys are the filter fields; a rule may name any of them. */
  openFilterFields: z.boolean().optional(),
  resourceRelationships: z.array(z.strictObject({
    // Duplicated from `ConnectorResourceRelationshipSchema` in
    // `automation-evaluators.ts` rather than imported, and the two must be
    // changed together: adding a value to only one type-checks and then rejects
    // the manifest at registry construction, for every connector at once.
    relationship: z.enum(["channel", "file", "folder", "parent", "project", "repository", "page", "thread", "application"]),
    resourceType: z.string().min(1).max(200),
  })).default([]),
  /**
   * Whether a person should be told about this activity in a digest.
   *
   * There is deliberately no default. A connector declares dozens of event
   * types, and most providers emit far more machinery than news: a repository
   * that reports every check run and every workflow transition will fill a
   * digest window with its own continuous integration before a single review
   * comment reaches the reader. Which of the two an event type is can only be
   * answered by whoever designed the connector, at the moment they added it, so
   * the contract asks then and refuses a manifest that stays quiet.
   *
   * `false` is not a lesser event. It still ingests, still routes, still
   * triggers automations and watches, and still appears in the activity log.
   * It just does not interrupt a person on a schedule.
   */
  digestible: z.boolean(),
});

/**
 * A connector that can hand a finished automation result to the person who
 * owns the automation, on a surface they read as themselves — a Slack Agent DM
 * today, a Teams chat later. Declaring this is what puts the connector in the
 * "Deliver results" list; nothing about delivery is hard-coded per provider.
 *
 * `requiresPersonalIdentityLink` marks the providers whose installation is
 * workspace-wide: the installation alone addresses no one, so the connection
 * only becomes a destination once the requesting user has linked their own
 * provider identity to it.
 */
export const ConnectorUserDeliverySchema = z.object({
  targetType: AutomationDeliveryTargetTypeSchema,
  label: z.string().min(1).max(80),
  description: z.string().min(1).max(240),
  requiresPersonalIdentityLink: z.boolean().default(false),
});

const ConnectorManifestBaseSchema = z.object({
  type: z.string().min(1),
  displayName: z.string().min(1),
  surfaces: z.array(ConnectorSurfaceSchema).min(1).default(["resource"]),
  nativeAgent: NativeAgentSurfaceSchema.optional(),
  messagingAgent: MessagingAgentSurfaceSchema.optional(),
  userDelivery: ConnectorUserDeliverySchema.optional(),
  capabilities: z.array(ConnectorCapabilitySchema).default([]),
  supportedScopes: z.array(ScopeSchema),
  oauthRequired: z.boolean(),
  activityTriggers: z.array(ConnectorActivityTriggerDescriptorSchema),
  resourceTypes: z.array(z.string()),
  tools: z.array(ToolDefinitionSchema),
  supportsWatches: z.boolean(),
  supportsPolling: z.boolean(),
  supportsWebhooks: z.boolean()
});

export const ConnectorManifestSchema = ConnectorManifestBaseSchema.superRefine((manifest, context) => {
  const activityTypes = new Set<string>();
  for (const [index, trigger] of manifest.activityTriggers.entries()) {
    if (activityTypes.has(trigger.eventType)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate connector activity type: ${trigger.eventType}`,
        path: ["activityTriggers", index, "eventType"]
      });
    }
    activityTypes.add(trigger.eventType);
    const filterKeys = new Set<string>();
    for (const [filterIndex, field] of trigger.filterFields.entries()) {
      if (filterKeys.has(field.key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate activity filter field: ${field.key}`,
          path: ["activityTriggers", index, "filterFields", filterIndex, "key"]
        });
      }
      filterKeys.add(field.key);
    }
  }
  const declaresNativeAgent = manifest.surfaces.includes("native_agent");
  if (declaresNativeAgent && !manifest.nativeAgent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A native-agent connector must declare its native agent capabilities",
      path: ["nativeAgent"]
    });
  }
  if (!declaresNativeAgent && manifest.nativeAgent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Native agent capabilities require the native_agent surface",
      path: ["surfaces"]
    });
  }
  const declaresMessagingAgent = manifest.surfaces.includes("messaging_agent");
  if (declaresMessagingAgent && !manifest.messagingAgent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A messaging-agent connector must declare its messaging agent capabilities",
      path: ["messagingAgent"]
    });
  }
  if (!declaresMessagingAgent && manifest.messagingAgent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Messaging agent capabilities require the messaging_agent surface",
      path: ["surfaces"]
    });
  }
  const capabilityIds = new Set<string>();
  for (const [index, capability] of manifest.capabilities.entries()) {
    if (capabilityIds.has(capability.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate connector capability: ${capability.id}`,
        path: ["capabilities", index, "id"]
      });
    }
    capabilityIds.add(capability.id);
  }
  const descriptorById = new Map(manifest.capabilities.map((capability) => [capability.id, capability]));
  for (const tool of manifest.tools) {
    const descriptor = descriptorById.get(tool.capability);
    if (descriptor && descriptor.kind !== "tool") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Tool capability ${tool.capability} must use kind tool`,
        path: ["capabilities"]
      });
    }
  }
  const declaresNativeAgentCapability = manifest.capabilities.some(
    (capability) => capability.kind === "native_agent"
  );
  if (declaresNativeAgent && !declaresNativeAgentCapability) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A native-agent connector must declare an authorizable native-agent capability",
      path: ["capabilities"]
    });
  }
  if (!declaresNativeAgent && declaresNativeAgentCapability) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Native-agent capabilities require the native_agent surface",
      path: ["capabilities"]
    });
  }
  const declaresMessagingAgentCapability = manifest.capabilities.some(
    (capability) => capability.kind === "messaging_agent"
  );
  if (declaresMessagingAgent && !declaresMessagingAgentCapability) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A messaging-agent connector must declare an authorizable messaging-agent capability",
      path: ["capabilities"]
    });
  }
  if (!declaresMessagingAgent && declaresMessagingAgentCapability) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Messaging-agent capabilities require the messaging_agent surface",
      path: ["capabilities"]
    });
  }
  if (manifest.nativeAgent) {
    const capability = manifest.capabilities.find(
      (candidate) => candidate.id === manifest.nativeAgent?.capability
    );
    if (!capability || capability.kind !== "native_agent") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Native-agent surface capability ${manifest.nativeAgent.capability} must name a native_agent capability`,
        path: ["nativeAgent", "capability"]
      });
    }
  }
  if (manifest.messagingAgent) {
    const capability = manifest.capabilities.find(
      (candidate) => candidate.id === manifest.messagingAgent?.capability
    );
    if (!capability || capability.kind !== "messaging_agent") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Messaging-agent surface capability ${manifest.messagingAgent.capability} must name a messaging_agent capability`,
        path: ["messagingAgent", "capability"]
      });
    }
  }
}).transform((manifest) => {
  const declaredIds = new Set(manifest.capabilities.map((capability) => capability.id));
  const inferredToolCapabilities = manifest.tools
    .filter((tool) => !declaredIds.has(tool.capability))
    .filter((tool, index, tools) => tools.findIndex((candidate) => candidate.capability === tool.capability) === index)
    .map((tool) => ({ id: tool.capability, kind: "tool" as const }));
  return {
    ...manifest,
    capabilities: [...manifest.capabilities, ...inferredToolCapabilities]
  };
}).transform((manifest) => ({
  ...manifest,
  activityTypes: manifest.activityTriggers.map((trigger) => trigger.eventType),
  // Derived rather than declared a second time: the descriptor is the single
  // authority on digestibility, and a consumer asking "may this event type
  // reach a digest" should not have to scan a list of descriptors to find out.
  digestibleActivityTypes: manifest.activityTriggers
    .filter((trigger) => trigger.digestible)
    .map((trigger) => trigger.eventType),
}));

export type Region = z.infer<typeof RegionSchema>;
export type Scope = z.infer<typeof ScopeSchema>;
export type User = z.infer<typeof UserSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;
export type WorkspaceInvitation = z.infer<typeof WorkspaceInvitationSchema>;
export type WorkspaceInvitee = z.infer<typeof WorkspaceInviteeSchema>;
export type WorkspaceInvitationPreview = z.infer<typeof WorkspaceInvitationPreviewSchema>;
export type PendingWorkspaceInvitation = z.infer<typeof PendingWorkspaceInvitationSchema>;
export type WorkspaceOnboardingState = z.infer<typeof WorkspaceOnboardingStateSchema>;
export type WorkspaceDeparture = z.infer<typeof WorkspaceDepartureSchema>;
export type WorkspaceDepartureOutcome = z.infer<typeof WorkspaceDepartureOutcomeSchema>;
export type WorkspaceAttention = z.infer<typeof WorkspaceAttentionSchema>;
export type OnboardingRegionRequest = z.infer<typeof OnboardingRegionRequestSchema>;
export type ActivateWorkspaceRequest = z.infer<typeof ActivateWorkspaceRequestSchema>;
export type WorkspaceInvitationRole = z.infer<typeof WorkspaceInvitationRoleSchema>;
export type AssignableMemberRole = z.infer<typeof AssignableMemberRoleSchema>;
export type UpdateWorkspaceMemberRoleRequest = z.infer<typeof UpdateWorkspaceMemberRoleRequestSchema>;
export type ClientFeatureFlags = z.infer<typeof ClientFeatureFlagsSchema>;
export type ProductFeatureFlagKey = z.infer<typeof ProductFeatureFlagKeySchema>;
export type ProductFeatureFlagFanoutMessage = z.infer<typeof ProductFeatureFlagFanoutMessageSchema>;
export type Workstream = z.infer<typeof WorkstreamSchema>;
export type WorkstreamDetail = z.infer<typeof WorkstreamDetailSchema>;
export type WorkstreamBoot = z.infer<typeof WorkstreamBootSchema>;
export type WorkstreamContext = z.infer<typeof WorkstreamContextSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type ExternalActor = z.infer<typeof ExternalActorSchema>;
export type Resource = z.infer<typeof ResourceSchema>;
export type WorkstreamResource = z.infer<typeof WorkstreamResourceSchema>;
export type ResourceVersionAuthor = z.infer<typeof ResourceVersionAuthorSchema>;
export type ResourceVersionCause = z.infer<typeof ResourceVersionCauseSchema>;
export type ResourceRevision = z.infer<typeof ResourceRevisionSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;
export type CustomMcpAuthMode = z.infer<typeof CustomMcpAuthModeSchema>;
export type CustomMcpToolPolicy = z.infer<typeof CustomMcpToolPolicySchema>;
export type CustomMcpConnectionConfig = z.infer<typeof CustomMcpConnectionConfigSchema>;
export type CustomMcpConnectionSettings = z.infer<typeof CustomMcpConnectionSettingsSchema>;
export type CustomMcpToolSummary = z.infer<typeof CustomMcpToolSummarySchema>;
export type GitHubRepositoryRemoteAccess = z.infer<typeof GitHubRepositoryRemoteAccessSchema>;
export type GitHubRepositoryAccessMode = z.infer<typeof GitHubRepositoryAccessModeSchema>;
export type GitHubRepositoryAccessEntry = z.infer<typeof GitHubRepositoryAccessEntrySchema>;
export type GitHubRepositoryAccessSettings = z.infer<typeof GitHubRepositoryAccessSettingsSchema>;
export type UpdateGitHubRepositoryAccessSettings = z.infer<typeof UpdateGitHubRepositoryAccessSettingsSchema>;
export type AutomationDeliveryTargetType = z.infer<typeof AutomationDeliveryTargetTypeSchema>;
export type ConnectorUserDelivery = z.infer<typeof ConnectorUserDeliverySchema>;
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;
export type BackgroundTask = z.infer<typeof BackgroundTaskSchema>;
export type Elicitation = z.infer<typeof ElicitationSchema>;
export type WorkOpportunity = z.infer<typeof WorkOpportunitySchema>;
export type WorkOpportunityPage = z.infer<typeof WorkOpportunityPageSchema>;
export type AutomationDraft = z.infer<typeof AutomationDraftSchema>;
export type AutomationMemoryTable = z.infer<typeof AutomationMemoryTableSchema>;
export type AutomationMemoryTableColumn = z.infer<typeof AutomationMemoryTableColumnSchema>;
export type MemoryTableColumnType = z.infer<typeof MemoryTableColumnTypeSchema>;
export type AutomationSummary = z.infer<typeof AutomationSummarySchema>;
export type AutomationDetail = z.infer<typeof AutomationDetailSchema>;
export type AutomationRun = z.infer<typeof AutomationRunSchema>;
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;
export type ActivitySourcePluginIds = z.infer<typeof ActivitySourcePluginIdsSchema>;
export type DigestSchedule = z.infer<typeof DigestScheduleSchema>;
export type DigestDeliveryTarget = z.infer<typeof DigestDeliveryTargetSchema>;
export type DigestDeliveryTargetType = z.infer<typeof DigestDeliveryTargetTypeSchema>;
export type UpdateDigestScheduleRequest = z.infer<typeof UpdateDigestScheduleRequestSchema>;
export type WorkstreamBatchFilter = z.infer<typeof WorkstreamBatchFilterSchema>;
export type WorkstreamBatchUpdate = z.infer<typeof WorkstreamBatchUpdateSchema>;
export type PreviewWorkstreamBatchRequest = z.infer<typeof PreviewWorkstreamBatchRequestSchema>;
export type ApplyWorkstreamBatchRequest = z.infer<typeof ApplyWorkstreamBatchRequestSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type ConnectorOAuthProvider = z.infer<typeof ConnectorOAuthProviderSchema>;
export type ConnectorOAuthAttemptStatus = z.infer<typeof ConnectorOAuthAttemptStatusSchema>;
export type ConnectorOAuthStart = z.infer<typeof ConnectorOAuthStartSchema>;
export type ConnectorOAuthAttempt = z.infer<typeof ConnectorOAuthAttemptSchema>;
export type ClientSocketEvent = z.infer<typeof ClientSocketEventSchema>;
export type SubstreamSocketMutationType = z.infer<typeof SubstreamSocketMutationTypeSchema>;
export type WorkstreamSocketCommandResult = z.infer<typeof WorkstreamSocketCommandResultSchema>;
export type WorkstreamMessageDeliveryState = z.infer<typeof WorkstreamMessageDeliveryStateSchema>;
export type WorkstreamMessageAdmissionReceipt = z.infer<typeof WorkstreamMessageAdmissionReceiptSchema>;
export type ActiveStreamCheckpoint = z.infer<typeof ActiveStreamCheckpointSchema>;
export type ServerSocketEvent = z.infer<typeof ServerSocketEventSchema>;
export type NormalizedActivity = z.infer<typeof NormalizedActivitySchema>;
export type ConnectorOriginResource = z.infer<typeof ConnectorOriginResourceSchema>;
export type ConnectorOriginResourceInput = z.input<typeof ConnectorOriginResourceSchema>;
export type ActivityQueueMessage = z.infer<typeof ActivityQueueMessageSchema>;
export type SlackIngressQueueMessage = z.infer<typeof SlackIngressQueueMessageSchema>;
export type ExecutionPrincipal = z.infer<typeof ExecutionPrincipalSchema>;
export type SlackOriginAttachment = z.infer<typeof SlackOriginAttachmentSchema>;
export type SlackOriginNearbyMessage = z.infer<typeof SlackOriginNearbyMessageSchema>;
export type SlackOriginContext = z.infer<typeof SlackOriginContextSchema>;
export type WorkstreamWorkflowInput = z.infer<typeof WorkstreamWorkflowInputSchema>;
/**
 * The person who asked for this run, or null when nobody did. A Sidekick run
 * carries a person as its principal too, but only as who it runs as: a turn
 * continuing it was asked for by the member who sent the input, a run started
 * by hand by whoever started it, and a scheduled or inbound run by nobody.
 */
export function runRequesterUserId(
  input: Pick<WorkstreamWorkflowInput, "executionPrincipal" | "automationRun" | "automationContinuation">,
): string | null {
  if (input.automationContinuation) return input.automationContinuation.senderUserId ?? null;
  if (input.automationRun) {
    return input.automationRun.trigger.kind === "manual" ? input.automationRun.trigger.requestedByUserId : null;
  }
  return input.executionPrincipal.type === "user" ? input.executionPrincipal.userId : null;
}

export const TerminalNetworkModeSchema = z.enum(["trusted_only", "full_internet"]);
export const TerminalNetworkVerificationStateSchema = z.enum(["pending", "verified", "failed"]);
export const TerminalWorkspaceSettingsSchema = z.strictObject({
  availability: z.enum(["supported", "unsupported", "emergency_disabled"]),
  mode: TerminalNetworkModeSchema,
  revision: z.number().int().positive(),
  verificationState: TerminalNetworkVerificationStateSchema,
  customDomains: z.array(z.string().min(1).max(253)).max(20),
  remainingCustomSlots: z.number().int().nonnegative().max(20),
  failureCode: z.string().min(1).max(160).nullable(),
});
export const PreviewTerminalNetworkPolicyRequestSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  mode: TerminalNetworkModeSchema,
  customDomains: z.array(z.string().min(1).max(253)).max(20),
});
export const TerminalNetworkPolicyPreviewSchema = z.strictObject({
  mutationId: IdSchema,
  expectedRevision: z.number().int().positive(),
  proposedMode: TerminalNetworkModeSchema,
  customDomains: z.array(z.string().min(1).max(253)).max(20),
  remainingCustomSlots: z.number().int().nonnegative().max(20),
});
export const ApplyTerminalNetworkPolicyRequestSchema = z.strictObject({
  mutationId: IdSchema,
  expectedRevision: z.number().int().positive(),
  confirmed: z.literal(true),
});
export const TerminalSandboxStateSchema = z.enum([
  "absent", "starting", "running", "stopped", "archived", "restoring", "expired", "failed",
]);
export const TerminalSelectedRepositorySchema = z.strictObject({
  id: z.number().int().positive(),
  fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  baseRef: z.string().min(1).max(240),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/u),
  headRef: z.string().min(1).max(240),
});
export const TerminalProviderObservationSchema = z.strictObject({
  state: z.string().nullable(),
  observedAt: TimestampSchema.nullable(),
  nextObserveAt: TimestampSchema,
  recoverable: z.boolean().nullable(),
  errorCode: z.string().nullable(),
});
export const TerminalWorkstreamStateSchema = z.strictObject({
  providerObservation: TerminalProviderObservationSchema.nullable().optional(),
  availability: z.enum(["supported", "unsupported", "emergency_disabled"]),
  state: TerminalSandboxStateSchema,
  lastActivityAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema.nullable(),
  retentionWarning: z.enum(["expires_within_7_days", "expires_within_24_hours"]).nullable(),
  localFilesRetained: z.boolean(),
  finalDiffResourceId: IdSchema.nullable(),
  failureCode: z.string().min(1).max(160).nullable(),
  repository: TerminalSelectedRepositorySchema.nullable(),
});
export type TerminalWorkspaceSettings = z.infer<typeof TerminalWorkspaceSettingsSchema>;
export type TerminalNetworkPolicyPreview = z.infer<typeof TerminalNetworkPolicyPreviewSchema>;
export type TerminalWorkstreamState = z.infer<typeof TerminalWorkstreamStateSchema>;
export type SlackSearchAuthorization = z.infer<typeof SlackSearchAuthorizationSchema>;
export type ConnectorPollWorkflowInput = z.infer<typeof ConnectorPollWorkflowInputSchema>;
export type AddressingClassification = z.infer<typeof AddressingClassificationSchema>;
export type WorkstreamNameResult = z.infer<typeof WorkstreamNameResultSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export type ConnectorSurface = z.infer<typeof ConnectorSurfaceSchema>;
export type NativeAgentInvocationMode = z.infer<typeof NativeAgentInvocationModeSchema>;
export type NativeAgentActivityKind = z.infer<typeof NativeAgentActivityKindSchema>;
export type ConnectorSurfaceMaturity = z.infer<typeof ConnectorSurfaceMaturitySchema>;
export type ConnectorSurfaceRuntimeStatus = z.infer<typeof ConnectorSurfaceRuntimeStatusSchema>;
export type NativeAgentSessionOwnership = z.infer<typeof NativeAgentSessionOwnershipSchema>;
export type NativeAgentSurface = z.infer<typeof NativeAgentSurfaceSchema>;
export type MessagingAgentSurface = z.infer<typeof MessagingAgentSurfaceSchema>;
export type ConnectorCapabilityKind = z.infer<typeof ConnectorCapabilityKindSchema>;
export type ConnectorCapability = z.infer<typeof ConnectorCapabilitySchema>;
export type ConnectorActivityFilterValueType = z.infer<typeof ConnectorActivityFilterValueTypeSchema>;
/** Input shape used while authoring manifests; parsing fills safe defaults. */
export type ConnectorActivityFilterField = z.input<typeof ConnectorActivityFilterFieldSchema>;
/** Authoring shape keeps V2 additions optional so existing connector manifests remain source-compatible. */
export type ConnectorActivityTriggerDescriptor = z.input<typeof ConnectorActivityTriggerDescriptorSchema>;
export type ConnectorActivityTriggerDescriptorInput = z.input<typeof ConnectorActivityTriggerDescriptorSchema>;
export type ParsedConnectorActivityTriggerDescriptor = z.output<typeof ConnectorActivityTriggerDescriptorSchema>;
/** Input permits legacy manifests that omit `surfaces`; parsing normalizes them. */
export type ConnectorManifestInput = z.input<typeof ConnectorManifestSchema>;
export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;

/**
 * The machine-readable half of a thrown tool failure, reduced to what is safe
 * to show a model.
 *
 * A tool that throws otherwise reaches the model as a single string, so any
 * remediation it attached — which family of identifier was expected, that a
 * connection needs reconnecting, what values were available — is lost exactly
 * where the caller needs it to recover. Reading the shape here rather than
 * importing a connector's error class keeps the harness free of a dependency on
 * any one provider package.
 *
 * The forwarded keys are an allowlist rather than a convention each adapter is
 * trusted to follow, because several already attach whole parsed provider error
 * bodies as their details. Forwarding those would put up to a quarter-megabyte
 * of raw provider JSON into the transcript, and from there into the inference
 * payload logs, on every failed call.
 */
const FORWARDED_FAILURE_DETAIL_KEYS = [
  "reason",
  "field",
  "expected",
  "available",
  "reconnectRequired",
  "retryable",
  "retryAfterMs",
  "actualMimeType",
  "attachmentKind",
  "resourceId",
  "suggestedCall",
  "resourceAuthorization",
] as const;

const MAXIMUM_FAILURE_DETAIL_BYTES = 8_000;
const MAXIMUM_FAILURE_REASON_LENGTH = 1_000;
/** Producer-side bounds for values sent through structured tool-failure recovery. */
export const MAXIMUM_FAILURE_VALUE_LENGTH = 160;
export const MAXIMUM_FAILURE_AVAILABLE_VALUES = 20;

export const ConnectorResourceAuthorizationHintSchema = z.strictObject({
  kind: z.literal("connector_resource_authorization"),
  provider: ConnectorOAuthProviderSchema,
  capability: z.string().min(1),
  operation: z.enum(["edit"]),
  resource: z.strictObject({
    id: z.string().min(1),
    type: z.string().regex(/^[a-z0-9_]{1,80}$/u),
    name: z.string().min(1),
  }),
});
export type ConnectorResourceAuthorizationHint = z.infer<typeof ConnectorResourceAuthorizationHintSchema>;

export const ConnectorResourceAuthorizationRequestSchema = ConnectorResourceAuthorizationHintSchema.extend({
  connectionId: IdSchema,
  parentKind: ConversationParentKindSchema.default("workstream"),
  parentId: IdSchema,
  substreamId: SubstreamIdSchema,
  failedToolInvocationId: z.string().min(1),
  continuationId: z.string().uuid(),
});
export type ConnectorResourceAuthorizationRequest = z.infer<typeof ConnectorResourceAuthorizationRequestSchema>;

/**
 * The Allow editing request a failed durable tool event carries, or null.
 *
 * The one reader for it, as `connectorConnectionCardInputFromToolEvent` is for
 * a connection card: the feed uses it to keep the row out of a plugin's folded
 * work, and the card uses it to render, so the two cannot disagree about which
 * rows are cards.
 */
export function connectorResourceAuthorizationRequestFromToolEvent(
  event: { output?: unknown; status?: string } | undefined,
): ConnectorResourceAuthorizationRequest | null {
  if (event?.status !== "failed") return null;
  const output = event.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const parsed = ConnectorResourceAuthorizationRequestSchema.safeParse(
    (output as Record<string, unknown>).recovery,
  );
  return parsed.success ? parsed.data : null;
}

export const ConnectorResourceAuthorizationTargetSchema = z.strictObject({
  parentKind: ConversationParentKindSchema.default("workstream"),
  parentId: IdSchema,
  substreamId: SubstreamIdSchema,
  failedToolInvocationId: z.string().min(1),
});
export type ConnectorResourceAuthorizationTarget = z.infer<typeof ConnectorResourceAuthorizationTargetSchema>;
export const StartConnectorResourceAuthorizationRequestSchema = z.strictObject({
  target: ConnectorResourceAuthorizationTargetSchema,
});
export type StartConnectorResourceAuthorizationRequest = z.infer<typeof StartConnectorResourceAuthorizationRequestSchema>;
export const ConnectorResourceAuthorizationStartSchema = z.strictObject({
  attemptId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  status: z.enum(["pending", "succeeded"]),
  url: HttpUrlSchema.nullable(),
});
export type ConnectorResourceAuthorizationStart = z.infer<typeof ConnectorResourceAuthorizationStartSchema>;

export interface StructuredFailureDetail {
  code: string;
  details?: Record<string, unknown>;
}

function sanitizeForwardedFailureDetail(key: typeof FORWARDED_FAILURE_DETAIL_KEYS[number], value: unknown): {
  valid: boolean;
  value?: unknown;
} {
  switch (key) {
    case "reason":
      return typeof value === "string" && value.length <= MAXIMUM_FAILURE_REASON_LENGTH
        ? { valid: true, value }
        : { valid: false };
    case "field":
    case "expected":
      return typeof value === "string" && value.length <= MAXIMUM_FAILURE_VALUE_LENGTH
        ? { valid: true, value }
        : { valid: false };
    case "resourceId": {
      const parsed = z.string().uuid().safeParse(value);
      return parsed.success ? { valid: true, value: parsed.data } : { valid: false };
    }
    case "available":
      return Array.isArray(value)
        && value.length <= MAXIMUM_FAILURE_AVAILABLE_VALUES
        && value.every((entry) => typeof entry === "string" && entry.length <= MAXIMUM_FAILURE_VALUE_LENGTH)
        ? { valid: true, value }
        : { valid: false };
    case "reconnectRequired":
    case "retryable":
      return typeof value === "boolean" ? { valid: true, value } : { valid: false };
    case "retryAfterMs":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000
        ? { valid: true, value }
        : { valid: false };
    case "actualMimeType":
      return value === null || (typeof value === "string" && value.length <= MAXIMUM_FAILURE_VALUE_LENGTH)
        ? { valid: true, value }
        : { valid: false };
    case "attachmentKind": {
      const parsed = AttachmentKindSchema.safeParse(value);
      return parsed.success ? { valid: true, value: parsed.data } : { valid: false };
    }
    case "suggestedCall": {
      // Accepts the wire names retired when the plugins dropped their prefixes:
      // this runs against stored `errorJson` on every reprojection, and an
      // invalid field here discards the entire detail rather than just itself.
      const parsed = parseStoredSuggestedAttachmentToolCall(value);
      return parsed.success ? { valid: true, value: parsed.data } : { valid: false };
    }
    case "resourceAuthorization": {
      const parsed = ConnectorResourceAuthorizationHintSchema.safeParse(value);
      return parsed.success ? { valid: true, value: parsed.data } : { valid: false };
    }
  }
}

export function readStructuredFailure(error: unknown): StructuredFailureDetail | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !code) return null;
  const raw = (error as { details?: unknown }).details;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { code };
  const source = raw as Record<string, unknown>;
  const details: Record<string, unknown> = {};
  for (const key of FORWARDED_FAILURE_DETAIL_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    const sanitized = sanitizeForwardedFailureDetail(key, value);
    if (!sanitized.valid) return { code };
    details[key] = sanitized.value;
  }
  if (Object.keys(details).length === 0) return { code };
  // A bound on the allowlisted values as well: `available` is a provider-shaped
  // list, so its length is not ours to assume.
  return JSON.stringify(details).length > MAXIMUM_FAILURE_DETAIL_BYTES
    ? { code }
    : { code, details };
}

/** Stored capability policy. Consumers read the persisted value, never derive it. */
export function sidekickLoadable(definition: Pick<AutomationDraft, "triggers" | "definitionVersion">): boolean {
  // Legacy accepted definitions include implicit email trigger configuration.
  return definition.definitionVersion === 2 && definition.triggers.length === 0;
}

/** Legacy definitions implicitly enabled inbound email when accepted. */
export function sidekickReceivesEmail(definition: AutomationDraft): boolean {
  return definition.definitionVersion !== 2
    || definition.triggers.some((trigger) => trigger.type === "inbound_email");
}

export const SidekickDefinitionSchema = AutomationDraftSchema;
export const SidekickSummarySchema = AutomationSummarySchema;
export const SidekickDetailSchema = AutomationDetailSchema;
export type SidekickDetail = AutomationDetail;
export type SidekickDefinition = AutomationDraft;
export type SidekickSummary = AutomationSummary;

export const SidekickSkillSourceSchema = z.object({
  id: IdSchema,
  revision: z.number().int().positive(),
  loadable: z.boolean(),
  name: z.string(),
  description: z.string(),
  whenToUse: z.string(),
  instructions: z.string(),
});
export type SidekickSkillSource = z.infer<typeof SidekickSkillSourceSchema>;
export const SidekickSkillSnapshotSchema = z.object({
  sources: z.array(SidekickSkillSourceSchema),
  activeRefs: z.array(z.string()),
  recommendedRefs: z.array(z.string()).optional(),
});
export type SidekickSkillSnapshot = z.infer<typeof SidekickSkillSnapshotSchema>;

export const SidekickAttachmentSchema = z.object({
  id: IdSchema, name: z.string(), description: z.string(), available: z.boolean(),
});
export type SidekickAttachment = z.infer<typeof SidekickAttachmentSchema>;

/** A resource attached to a Channel's Main conversation, as its rail lists it. */
export const ChannelRailResourceSchema = z.strictObject({
  id: IdSchema,
  title: z.string().max(300),
  resourceType: z.string().min(1).max(80),
  mimeType: z.string().max(160).nullable(),
  direction: ResourceDirectionSchema,
  currentVersion: z.number().int().positive(),
});
export type ChannelRailResource = z.infer<typeof ChannelRailResourceSchema>;

/**
 * An owned Sidekick as the rail lists it: the summary without its run times
 * and update time, which move on every scheduled run and which the rail does
 * not show, so they do not advance the rail waterline.
 */
export const ChannelRailOwnedSidekickSchema = WorkstreamAutomationSummarySchema.omit({
  nextRunAt: true,
  lastRunAt: true,
  updatedAt: true,
});
export type ChannelRailOwnedSidekick = z.infer<typeof ChannelRailOwnedSidekickSchema>;

/** Everything a Channel's rail lists beyond its row, for one viewer. */
export const ChannelRailSchema = z.strictObject({
  workstreamId: WorkstreamIdSchema,
  railWaterline: z.number().int().nonnegative(),
  /** Main's participants, newest first. */
  participantUserIds: z.array(UserIdSchema),
  sidekicks: z.strictObject({
    /** Empty unless the viewer is a member participant, as the REST read. */
    owned: z.array(ChannelRailOwnedSidekickSchema),
    recommended: z.array(SidekickAttachmentSchema),
    /** Main's attachments; absent until Main has reported them. */
    attached: z.array(SidekickAttachmentSchema).optional(),
  }),
  resources: z.array(ChannelRailResourceSchema),
});
export type ChannelRail = z.infer<typeof ChannelRailSchema>;

/**
 * One frame of a `channel_rails` answer. A long answer spans frames; the last
 * says `final`.
 */
export const WorkspaceChannelRailsEventSchema = z.strictObject({
  type: z.literal("workspace_channel_rails"),
  requestId: IdSchema,
  rails: z.array(ChannelRailSchema),
  /** Rails too large for one frame; the client paints these from the snapshot. */
  oversized: z.array(z.strictObject({ workstreamId: WorkstreamIdSchema, railWaterline: z.number().int().nonnegative() })),
  /** Named Channels this viewer may not see, or that have no rail yet. */
  unavailable: z.array(WorkstreamIdSchema),
  /**
   * Always null: it paged the Space target, which is gone. Still sent, since
   * desktops before this change require it; optional so a later server can
   * stop sending it.
   */
  nextAfter: WorkstreamIdSchema.nullable().optional(),
  final: z.boolean(),
});
export type WorkspaceChannelRailsEvent = z.infer<typeof WorkspaceChannelRailsEventSchema>;
export const SidekickAttachmentsSchema = z.object({ items: z.array(SidekickAttachmentSchema) });
/** Sources eligible for an explicit workstream recommendation in this conversation. */
export const SidekickRecommendationOptionsSchema = z.object({
  canManage: z.boolean(),
  items: z.array(SidekickAttachmentSchema.extend({ attached: z.boolean() })),
});
export type SidekickRecommendationOptions = z.infer<typeof SidekickRecommendationOptionsSchema>;


export { isUnknownSocketEvent,safeParseSocketEvent } from "./socket-events";

export const ClientSocketEventTypeSchema = z.union(ClientSocketEventSchema.options.map((event) => event.shape.type));
export const WorkspaceSocketClientEventTypeSchema = z.union(WorkspaceSocketClientEventSchema.options.map((event) => event.shape.type));

export { ConnectorEventConsoleProviders,ConnectorInstallationProviderSchema,ConnectorInstallationProviders,ConnectorInstallationSchema,ConnectorRegistrationSchema,type ConnectorEventConsoleProvider,type ConnectorInstallation,type ConnectorInstallationProvider,type InstallationRegistration } from "./connector-installation";
export { ConnectorApiKeyGuidanceCatalog,ConnectorApiKeyProviders,connectorApiKeyAcceptable,connectorApiKeyMismatch,isConnectorApiKeyProvider,type ConnectorApiKeyFormat,type ConnectorApiKeyGuidance,type ConnectorApiKeyProvider } from "./connector-api-keys";

export { AshbyEventLabels,AshbyEventTypes } from "./ashby-events";

export * from "./substream-content";
