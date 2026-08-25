import {
  BlockDashboardBlockRunSchema,
  BlockIdSchema,
  HarnessRunIdSchema,
  IdSchema,
  RegionSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
  UpdateBlockDashboardRequestSchema,
  WorkstreamCompactionFenceSchema,
} from "@rally/contracts";
import { z } from "zod";

const CoordinatesSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
}).strict();

export const BlockDashboardSourceRefreshRequestSchema = CoordinatesSchema.extend({
  triggerSequence: z.number().int().nonnegative(),
}).strict();

export const BlockDashboardContextFenceSchema = z.object({
  /** Inclusive upper bound that is a complete provider-valid boundary. */
  throughSequence: z.number().int().nonnegative(),
  /** Exact compacted prefix, or null to begin at the start of the array. */
  compaction: WorkstreamCompactionFenceSchema.nullable(),
}).strict();

export const BlockDashboardControlRequestSchema = z.discriminatedUnion("operation", [
  CoordinatesSchema.extend({ operation: z.literal("get") }).strict(),
  CoordinatesSchema.extend({
    operation: z.literal("get_preference"),
    userId: IdSchema,
  }).strict(),
  CoordinatesSchema.extend({
    operation: z.literal("update_preference"),
    userId: IdSchema,
    visible: z.boolean(),
    updatedAt: z.string().datetime({ offset: true }),
  }).strict(),
  CoordinatesSchema.extend({
    operation: z.literal("update_configuration"),
    userId: IdSchema,
    input: UpdateBlockDashboardRequestSchema,
    configurationVersionId: IdSchema,
    createdAt: z.string().datetime({ offset: true }),
  }).strict(),
  CoordinatesSchema.extend({
    operation: z.literal("schedule_refresh"),
    triggerSequence: z.number().int().nonnegative(),
    contextFence: BlockDashboardContextFenceSchema,
  }).strict(),
  CoordinatesSchema.extend({
    operation: z.literal("block_result"),
    blockId: IdSchema,
    sourceVersion: z.number().int().positive(),
    payloadHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
    run: BlockDashboardBlockRunSchema,
  }).strict(),
  CoordinatesSchema.extend({
    operation: z.literal("import_authority_rows"),
    generation: z.number().int().positive(),
    configurations: z.array(z.object({
      configurationVersionId: IdSchema,
      versionNumber: z.number().int().positive(),
      blocksJson: z.string().refine((value) => {
        try { return Array.isArray(JSON.parse(value)); } catch { return false; }
      }),
      createdByUserId: IdSchema,
      createdAt: z.number().int().nonnegative(),
    }).strict()).max(250),
    runs: z.array(z.object({
      blockRunId: IdSchema,
      configurationVersionId: IdSchema,
      blockId: IdSchema,
      prompt: z.string().max(12_000),
      triggerSequence: z.number().int().nonnegative(),
      harnessRunId: IdSchema,
      status: z.enum(["queued", "running", "completed", "failed", "stopped"]),
      markdown: z.string().nullable(),
      errorJson: z.string().nullable(),
      createdAt: z.number().int().nonnegative(),
      startedAt: z.number().int().nonnegative().nullable(),
      completedAt: z.number().int().nonnegative().nullable(),
    }).strict()).max(250),
    preferences: z.array(z.object({
      userId: IdSchema,
      visible: z.boolean(),
      updatedAt: z.number().int().nonnegative(),
    }).strict()).max(250),
  }).strict(),
]);

export const BlockDashboardBlockDispatchSchema = z.object({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  blockId: BlockIdSchema,
  blockRunId: IdSchema,
  harnessRunId: HarnessRunIdSchema,
  configurationVersionId: IdSchema,
  configurationVersionNumber: z.number().int().positive(),
  prompt: z.string().min(1).max(12_000),
  triggerSequence: z.number().int().nonnegative(),
  contextFence: BlockDashboardContextFenceSchema,
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const BlockDashboardViewerAuthorizationRequestSchema = CoordinatesSchema.extend({
  blockId: BlockIdSchema,
  userId: UserIdSchema,
}).strict();

/**
 * Close the sockets of a block that stopped existing.
 *
 * Deliberately names no user: a person losing access is carried by the
 * access-revocation queue instead, and a second per-user path here would be a
 * quieter answer to the same question. See `docs/access-revocation.md`.
 */
export const BlockDashboardSocketRetractionRequestSchema = CoordinatesSchema.extend({
  blockId: BlockIdSchema,
  region: RegionSchema,
}).strict();

export type BlockDashboardBlockDispatch = z.infer<typeof BlockDashboardBlockDispatchSchema>;
export type BlockDashboardContextFence = z.infer<typeof BlockDashboardContextFenceSchema>;
export type BlockDashboardControlRequest = z.infer<typeof BlockDashboardControlRequestSchema>;
export type BlockDashboardSourceRefreshRequest = z.infer<typeof BlockDashboardSourceRefreshRequestSchema>;
export type BlockDashboardSocketRetractionRequest = z.infer<typeof BlockDashboardSocketRetractionRequestSchema>;
export type BlockDashboardViewerAuthorizationRequest = z.infer<typeof BlockDashboardViewerAuthorizationRequestSchema>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

export function blockDashboardBlockResultHash(run: z.infer<typeof BlockDashboardBlockRunSchema>): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(canonicalJson(run))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}
