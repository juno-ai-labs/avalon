import { RegionSchema } from "@rally/contracts/regions";
import { z } from "zod";

import { IdSchema } from "./identifiers";

/**
 * The demo preparation operation on the wire: what Ace asks the regional API
 * to start, and what it reads back while it runs. `docs/demo-workspaces.md`
 * owns the feature; these are the shapes both ends parse.
 */

export const DEMO_PREPARATION_PHASES = [
  "checking_template",
  "creating_workspace",
  "copying_connections",
  "seeding_conversations",
  "waiting_for_workspace",
] as const;
export const DemoPreparationPhaseSchema = z.enum(DEMO_PREPARATION_PHASES);
export type DemoPreparationPhase = z.infer<typeof DemoPreparationPhaseSchema>;

export const DemoOperationStatusValueSchema = z.enum(["running", "ready", "failed", "abandoned"]);

const RoleSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u);

/**
 * Who plays one part: a colleague's account, or a name the operator typed.
 * A name is played by a persona the region mints for this operation — a user
 * with that name and no way to sign in — so a demo can be staffed by anyone,
 * including more people than the company has.
 */
export const DemoCastEntrySchema = z.union([
  IdSchema,
  z.strictObject({ name: z.string().trim().min(1).max(255) }),
]);
export type DemoCastEntry = z.infer<typeof DemoCastEntrySchema>;

/**
 * What the operator submits. The pack is the regional API's; the cast is the
 * operator's — per role, either a colleague on the company's own email domain
 * or a typed name. The presenter is always a real template member, because
 * they sign in and show it.
 */
export const DemoOperationStartRequestSchema = z.strictObject({
  operationId: IdSchema,
  companyName: z.string().trim().min(1).max(80),
  presenterUserId: IdSchema,
  /** Who plays each pack role but the presenter's. */
  cast: z.record(RoleSchema, DemoCastEntrySchema),
});
export type DemoOperationStartRequest = z.infer<typeof DemoOperationStartRequestSchema>;

/**
 * The confirmation the page collected before abandoning: the operator named
 * the operation they are closing. Carried to the API so the irreversible
 * retirement of the candidate is refused unless the two agree, rather than
 * trusting the page to have asked.
 */
export const DemoOperationAbandonRequestSchema = z.strictObject({
  confirmOperationId: IdSchema,
});
export type DemoOperationAbandonRequest = z.infer<typeof DemoOperationAbandonRequestSchema>;

/** One thing a viewer's projection does not yet show; the wait phase's detail carries a list of these. */
export const DemoReadinessGapSchema = z.strictObject({
  viewerUserId: IdSchema,
  /**
   * The pack's name for the Canvas or Sidekick the gap is about; null for the
   * viewer's lists as a whole. Named `room` because the page reads the field
   * by its released name, from when a pack made rooms.
   */
  room: z.string().nullable(),
  code: z.string().min(1),
  detail: z.string(),
});
export type DemoReadinessGap = z.infer<typeof DemoReadinessGapSchema>;

export const DemoOperationErrorSchema = z.strictObject({
  code: z.string().min(1).max(120),
  message: z.string().min(1).max(1200),
});

export const DemoOperationPhaseStatusSchema = z.strictObject({
  phase: DemoPreparationPhaseSchema,
  status: z.enum(["running", "completed", "failed"]),
  attempt: z.number().int().positive(),
  /** A small object the page renders; its keys are the phase's own. */
  detail: z.record(z.string(), z.unknown()),
  error: DemoOperationErrorSchema.nullable(),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
});
export type DemoOperationPhaseStatus = z.infer<typeof DemoOperationPhaseStatusSchema>;

export const DemoOperationStatusSchema = z.strictObject({
  operationId: IdSchema,
  companyName: z.string().min(1).max(80),
  presenterUserId: IdSchema,
  presenterName: z.string().min(1).max(255).nullable(),
  packVersion: z.string().min(1).max(80),
  /** Who plays each role, by user id: the presenter, and the colleagues cast with them. */
  cast: z.record(RoleSchema, IdSchema),
  /** The name each of those carries in the demo's directory, for the page to show. */
  castNames: z.record(RoleSchema, z.string().min(1).max(255)),
  workspaceId: IdSchema.nullable(),
  workspaceName: z.string().min(1).max(120).nullable(),
  status: DemoOperationStatusValueSchema,
  attempt: z.number().int().positive(),
  failedPhase: DemoPreparationPhaseSchema.nullable(),
  error: DemoOperationErrorSchema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  /** From the register: when the demo was published, and when it was closed. */
  readyAt: z.string().datetime({ offset: true }).nullable(),
  retiredAt: z.string().datetime({ offset: true }).nullable(),
  phases: z.array(DemoOperationPhaseStatusSchema).max(DEMO_PREPARATION_PHASES.length),
  /** Seed actions confirmed so far, out of the pack's total. */
  seeding: z.strictObject({
    confirmed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});
export type DemoOperationStatus = z.infer<typeof DemoOperationStatusSchema>;

export const DemoOperationListSchema = z.strictObject({
  operations: z.array(DemoOperationStatusSchema),
});

/** One person a role can be played by, as the form lists them. */
export const DemoCastCandidateSchema = z.strictObject({
  userId: IdSchema,
  name: z.string().min(1).max(255),
  email: z.string().max(254),
});
export type DemoCastCandidate = z.infer<typeof DemoCastCandidateSchema>;

/**
 * What the New demo form is built from: the pack's roles, the template's
 * members, who the presenter is chosen from, and the accounts every other
 * role can be played by. The two lists are different questions — a presenter
 * is handed the template's connections, a cast member is only seated — so
 * they are answered separately rather than filtered from one.
 */
export const DemoTemplateSchema = z.strictObject({
  workspaceId: IdSchema,
  pack: z.strictObject({
    version: z.string().min(1).max(80),
    roles: z.array(RoleSchema),
    /** The role the presenter plays, which is cast from the template's members. */
    presenterRole: RoleSchema.nullable(),
    /** What each other role is — the part the operator casts somebody into, which labels its field. */
    roleLabels: z.record(RoleSchema, z.string().min(1).max(40)),
  }),
  members: z.array(z.strictObject({
    userId: IdSchema,
    name: z.string().min(1).max(255),
    email: z.string().max(254),
    role: z.enum(["owner", "admin", "member"]),
  })),
  /** Everyone on the company's email domain who has signed in to this region. */
  castCandidates: z.array(DemoCastCandidateSchema),
  /** The domain those were drawn from, so the page can say whose list it is showing. */
  castEmailDomain: z.string().min(1).max(253),
});
export type DemoTemplate = z.infer<typeof DemoTemplateSchema>;

/** The Workflow's payload: a pointer, re-read on arrival. */
export const DemoPreparationWorkflowInputSchema = z.strictObject({
  region: RegionSchema,
  operationId: IdSchema,
  attempt: z.number().int().positive(),
});
export type DemoPreparationWorkflowInput = z.infer<typeof DemoPreparationWorkflowInputSchema>;
