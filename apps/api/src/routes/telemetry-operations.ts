import { OffsetDateTimeSchema } from "@rally/contracts/schema-runtime";
import { STRICT_UUID_PATTERN } from "@rally/contracts/uuid-validation";
import { Hono } from 'hono';
import { z } from 'zod/v3';
import type { HonoAppEnv } from '../env';
import { ApiError } from '../lib/api-error';
import { zValidator } from '../middleware/validation';
import { getTelemetryOperator, requireTelemetryOperator } from '../telemetry/operator-auth';
import { readTelemetryOperationalSnapshot } from '../telemetry/operations';
import { replayTelemetryEvent } from '../telemetry/replay';
import {
  queryEuCrashFreeLaunches,
  queryEuCrashIssues,
  readRawCrashForSupport,
} from '../telemetry/crash-operations';

const UuidV7Schema = z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID").refine((value) => value[14] === '7');
const ReplaySchema = z.object({
  eventId: UuidV7Schema,
  reason: z.enum(['destination_recovery', 'incident_response']),
}).strict();
const CrashIdSchema = z.object({ crashId: UuidV7Schema }).strict();
const CrashAccessQuerySchema = z.object({
  reason: z.enum(['customer_support', 'incident_response']),
}).strict();
const EuIssueQuerySchema = z.object({
  limit: z.coerce.number().int().safe().min(1).max(100).default(50),
}).strict();
const CrashFreeSchema = z.object({
  from: OffsetDateTimeSchema,
  to: OffsetDateTimeSchema,
}).strict();
const TelemetryOperationalSnapshotSchema = z.object({
  acceptedPending: z.number().int().safe().nonnegative(),
  acceptedTerminal: z.number().int().safe().nonnegative(),
  crashPending: z.number().int().safe().nonnegative(),
  crashTerminal: z.number().int().safe().nonnegative(),
  profilePending: z.number().int().safe().nonnegative(),
  profileTerminal: z.number().int().safe().nonnegative(),
  rejectionCount: z.number().int().safe().nonnegative(),
  openCircuits: z.number().int().safe().nonnegative(),
  oldestAcceptedAgeSeconds: z.number().int().safe().nonnegative().nullable(),
  oldestCrashAgeSeconds: z.number().int().safe().nonnegative().nullable(),
  oldestProfileAgeSeconds: z.number().int().safe().nonnegative().nullable(),
}).strict();
const ReplayResponseSchema = z.object({
  result: z.enum([
    'requeued',
    'denied',
    'not_found',
    'wrong_region',
    'expired',
    'suppressed',
    'invalid_state',
  ]),
  eventId: UuidV7Schema,
}).strict();
const EuCrashIssueSchema = z.object({
  fingerprint: z.string().min(1),
  firstSeen: OffsetDateTimeSchema,
  lastSeen: OffsetDateTimeSchema,
  count: z.number().int().safe().nonnegative(),
  releases: z.array(z.string()),
}).strict();
const EuCrashIssuesResponseSchema = z.object({
  issues: z.array(EuCrashIssueSchema),
}).strict();
const EuCrashFreeSegmentSchema = z.object({
  release: z.string(),
  platform: z.string(),
  architecture: z.string(),
  channel: z.string(),
  eligibleLaunches: z.number().int().safe().nonnegative(),
  crashedLaunches: z.number().int().safe().nonnegative(),
  crashFreeLaunches: z.number().int().safe().nonnegative(),
  uncorrelatedCrashes: z.number().int().safe().nonnegative(),
}).strict();
const EuCrashFreeResponseSchema = z.object({
  segments: z.array(EuCrashFreeSegmentSchema),
}).strict();

export const telemetryOperatorRoutes = new Hono<HonoAppEnv>();
telemetryOperatorRoutes.use('*', requireTelemetryOperator);

telemetryOperatorRoutes.get('/status', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(TelemetryOperationalSnapshotSchema.parse(
    await readTelemetryOperationalSnapshot(c.env),
  ));
});

telemetryOperatorRoutes.post('/replay', zValidator('json', ReplaySchema), async (c) => {
  const principal = getTelemetryOperator(c);
  if (principal.role !== 'security') {
    throw new ApiError(403, 'operator_role_forbidden', 'This operator role cannot replay telemetry');
  }
  return c.json(ReplayResponseSchema.parse(
    await replayTelemetryEvent(c.env, c.req.valid('json'), principal),
  ));
});

telemetryOperatorRoutes.get(
  '/crashes/:crashId/raw',
  zValidator('param', CrashIdSchema),
  zValidator('query', CrashAccessQuerySchema),
  async (c) => {
    const object = await readRawCrashForSupport(c.env, {
      crashId: c.req.valid('param').crashId,
      reason: c.req.valid('query').reason,
    }, getTelemetryOperator(c));
    if (!object) throw new ApiError(404, 'crash_report_not_found', 'The crash report is unavailable');
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(object.size),
      'Content-Disposition': `attachment; filename="${c.req.valid('param').crashId}.dmp"`,
      ...(object.httpEtag ? { ETag: object.httpEtag } : {}),
    });
    return new Response(object.body, { headers });
  },
);

telemetryOperatorRoutes.get('/eu/crash-issues', zValidator('query', EuIssueQuerySchema), async (c) => {
  if (c.env.AVALON_REGION !== 'eu') {
    throw new ApiError(404, 'not_found', 'The requested API route does not exist');
  }
  c.header('Cache-Control', 'no-store');
  return c.json(EuCrashIssuesResponseSchema.parse({
    issues: await queryEuCrashIssues(c.env, c.req.valid('query')),
  }));
});

telemetryOperatorRoutes.post('/eu/crash-free-launches', zValidator('json', CrashFreeSchema), async (c) => {
  if (c.env.AVALON_REGION !== 'eu') {
    throw new ApiError(404, 'not_found', 'The requested API route does not exist');
  }
  c.header('Cache-Control', 'no-store');
  return c.json(EuCrashFreeResponseSchema.parse({
    segments: await queryEuCrashFreeLaunches(c.env, c.req.valid('json')),
  }));
});
