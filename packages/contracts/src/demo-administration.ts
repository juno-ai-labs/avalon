import { z } from "zod";

import { DemoPackShapeSchema } from "./demo-pack";
import {
  DemoCastCandidateSchema,
  DemoCastEntrySchema,
  DemoOperationStatusSchema,
  DemoOperationStatusValueSchema,
} from "./demo-operations";
import { IdSchema } from "./identifiers";

/**
 * The Demo MCP's RPC to the regional API: the `DemoAdministration` entrypoint
 * the Global API Worker exports and the `rally-demo-mcp` Worker binds.
 *
 * Every answer is a result envelope rather than a throw, because a Worker RPC
 * reduces a thrown error to a bare `Error` with no code, and every failure here
 * has a code a model is told to act on. `docs/demo-mcp.md` owns the surface;
 * the operation underneath is `docs/demo-workspaces.md`'s.
 */

/** Who asked, from the Access assertion the MCP Worker verified. The API cannot check it and trusts the binding. */
export const DemoAdministrationActorSchema = z.strictObject({
  subject: z.string().min(1).max(255),
  email: z.string().max(254).nullable(),
});
export type DemoAdministrationActor = z.infer<typeof DemoAdministrationActorSchema>;

/** The one built-in scenario's id. */
export const BUILTIN_DEMO_SCENARIO_ID = "builtin:multiplayer";

/**
 * A client-chosen name for one demo it means to create. The operation id is
 * derived from it and the actor, so a repeat finds the same demo.
 */
export const DemoRequestKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/u);

const RoleSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u);

/** Which scenario: the built-in one, a stored revision, or a pack passed whole. */
export const DemoScenarioRefSchema = z.union([
  z.strictObject({ scenarioId: z.literal(BUILTIN_DEMO_SCENARIO_ID) }),
  z.strictObject({ revisionId: IdSchema }),
  z.strictObject({ pack: z.unknown() }),
]);
export type DemoScenarioRef = z.infer<typeof DemoScenarioRefSchema>;

/**
 * The same choice as the Demo MCP advertises it: the pack's full shape, so a
 * client's model can write one. The MCP Worker parses arguments itself; this is
 * only ever turned into JSON Schema.
 */
export const AdvertisedDemoScenarioRefSchema = z.union([
  z.strictObject({ scenarioId: z.literal(BUILTIN_DEMO_SCENARIO_ID) }),
  z.strictObject({ revisionId: IdSchema }),
  z.strictObject({ pack: DemoPackShapeSchema }),
]);

export const DemoPackIssueSchema = z.strictObject({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});
export type DemoPackIssue = z.infer<typeof DemoPackIssueSchema>;

/** A refusal, by code, with the sentence the model acts on. */
export const DemoAdministrationFailureSchema = z.strictObject({
  ok: z.literal(false),
  code: z.string().min(1).max(160),
  message: z.string().min(1).max(1200),
  issues: z.array(DemoPackIssueSchema).optional(),
});
export type DemoAdministrationFailure = z.infer<typeof DemoAdministrationFailureSchema>;

export type DemoAdministrationResult<T> = { ok: true; value: T } | DemoAdministrationFailure;

export const DemoPackSummarySchema = z.strictObject({
  spaces: z.number().int().nonnegative(),
  channels: z.number().int().nonnegative(),
  breakouts: z.number().int().nonnegative(),
  sidekicks: z.number().int().nonnegative(),
  uploads: z.number().int().nonnegative(),
  parts: z.array(RoleSchema),
  seededRuns: z.number().int().nonnegative(),
});

export const DemoScenarioListItemSchema = z.strictObject({
  scenarioId: z.string(),
  source: z.literal("builtin"),
  name: z.string(),
  description: z.string(),
  revision: z.string(),
  summary: DemoPackSummarySchema,
});

export const ListDemoScenariosInputSchema = z.strictObject({});

export const DemoScenarioListSchema = z.strictObject({ scenarios: z.array(DemoScenarioListItemSchema) });
export type DemoScenarioList = z.infer<typeof DemoScenarioListSchema>;

export const GetDemoScenarioInputSchema = z.union([
  z.strictObject({ scenarioId: z.literal(BUILTIN_DEMO_SCENARIO_ID) }),
  z.strictObject({ revisionId: IdSchema }),
]);
export type GetDemoScenarioInput = z.infer<typeof GetDemoScenarioInputSchema>;

export const DemoScenarioSchema = z.strictObject({
  scenarioId: z.string().nullable(),
  revisionId: IdSchema.nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  revision: z.string().nullable(),
  contentHash: z.string(),
  pack: z.unknown(),
});
export type DemoScenario = z.infer<typeof DemoScenarioSchema>;

export const CheckDemoScenarioInputSchema = z.strictObject({
  pack: z.unknown(),
  cast: z.record(RoleSchema, DemoCastEntrySchema).optional(),
});
export type CheckDemoScenarioInput = z.infer<typeof CheckDemoScenarioInputSchema>;

export const DemoScenarioCheckSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    contentHash: z.string(),
    pack: z.unknown(),
    summary: DemoPackSummarySchema,
    derived: z.array(z.string()),
    preview: z.string(),
  }),
  z.strictObject({ ok: z.literal(false), issues: z.array(DemoPackIssueSchema) }),
]);
export type DemoScenarioCheck = z.infer<typeof DemoScenarioCheckSchema>;

export const DemoCastCandidatesInputSchema = z.strictObject({ scenario: DemoScenarioRefSchema.optional() });
export type DemoCastCandidatesInput = z.infer<typeof DemoCastCandidatesInputSchema>;

export const DemoCastCandidatesSchema = z.strictObject({
  presenters: z.array(DemoCastCandidateSchema),
  colleagues: z.array(DemoCastCandidateSchema),
  parts: z.array(z.strictObject({ role: RoleSchema, label: z.string() })).optional(),
});
export type DemoCastCandidates = z.infer<typeof DemoCastCandidatesSchema>;

export const CreateDemoOrganizationInputSchema = z.strictObject({
  requestKey: DemoRequestKeySchema,
  scenario: DemoScenarioRefSchema,
  companyName: z.string().trim().min(1).max(80),
  presenterUserId: IdSchema,
  cast: z.record(RoleSchema, DemoCastEntrySchema),
});
export type CreateDemoOrganizationInput = z.infer<typeof CreateDemoOrganizationInputSchema>;

export const DemoOperationRecoverySchema = z.enum(["retry_demo_operation", "abandon_demo_operation"]);

export const DemoOperationNoticeSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
});

/**
 * The shipped status, every field of it, plus what only the Demo MCP reads.
 * The additions live here and never on `DemoOperationStatusSchema`, which Ace
 * parses strictly: a new field there would break Ace's Demos list the moment an
 * MCP-made demo appeared in it.
 */
export const DemoAdministrationOperationSchema = DemoOperationStatusSchema.extend({
  requestKey: z.string().nullable(),
  scenario: z.strictObject({
    source: z.enum(["builtin", "stored", "legacy"]),
    revisionId: IdSchema.nullable(),
    contentHash: z.string().nullable(),
  }),
  requestedBy: z.string().nullable(),
  recovery: DemoOperationRecoverySchema.nullable(),
  notices: z.array(DemoOperationNoticeSchema),
});
export type DemoAdministrationOperation = z.infer<typeof DemoAdministrationOperationSchema>;

export const ListDemoOperationsInputSchema = z.strictObject({
  status: DemoOperationStatusValueSchema.optional(),
});
export type ListDemoOperationsInput = z.infer<typeof ListDemoOperationsInputSchema>;

export const DemoAdministrationOperationListSchema = z.strictObject({
  operations: z.array(DemoAdministrationOperationSchema),
});

export const DemoOperationRefSchema = z.strictObject({ operationId: IdSchema });

export const RetryDemoOperationInputSchema = z.strictObject({
  operationId: IdSchema,
  expectedAttempt: z.number().int().positive(),
});
export type RetryDemoOperationInput = z.infer<typeof RetryDemoOperationInputSchema>;

export const AbandonDemoOperationInputSchema = z.strictObject({
  operationId: IdSchema,
  confirmOperationId: IdSchema,
});
export type AbandonDemoOperationInput = z.infer<typeof AbandonDemoOperationInputSchema>;

export const RetireDemoOrganizationInputSchema = z.strictObject({
  organizationId: IdSchema,
  confirmName: z.string().min(1).max(160),
});
export type RetireDemoOrganizationInput = z.infer<typeof RetireDemoOrganizationInputSchema>;

export const RetireDemoOrganizationResultSchema = z.strictObject({
  organizationId: IdSchema,
  retiredAt: z.string().nullable(),
  complete: z.boolean(),
});
export type RetireDemoOrganizationResult = z.infer<typeof RetireDemoOrganizationResultSchema>;

/** What a call carries besides its input: who made it. */
export interface DemoAdministrationCall<T> {
  actor: DemoAdministrationActor;
  input: T;
}

/**
 * Every input is `unknown` on purpose: the MCP Worker forwards arguments as the
 * client sent them, and the entrypoint parses them and refuses by code.
 */
export interface DemoAdministrationRpc {
  listScenarios(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<DemoScenarioList>>;
  getScenario(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<DemoScenario>>;
  checkScenario(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<DemoScenarioCheck>>;
  castCandidates(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<DemoCastCandidates>>;
  createOrganization(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<DemoAdministrationOperation>>;
  listOperations(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<{ operations: DemoAdministrationOperation[] }>>;
  getOperation(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<DemoAdministrationOperation>>;
  retryOperation(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<DemoAdministrationOperation>>;
  abandonOperation(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<DemoAdministrationOperation>>;
  retireOrganization(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<RetireDemoOrganizationResult>>;
}

/**
 * The operation id a request key names, for one actor: a UUID (version 8,
 * RFC 9562) built from SHA-256 of the two. The same actor and key always name
 * the same operation, so a repeated create finds its demo; another actor's
 * same key is another demo.
 */
export async function demoOperationIdForRequest(actorSubject: string, requestKey: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`demo-request\n${actorSubject}\n${requestKey}`),
  ));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
