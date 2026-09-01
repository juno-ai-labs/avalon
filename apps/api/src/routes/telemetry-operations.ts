import { Hono } from 'hono';
import { z } from 'zod';
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

const UuidV7Schema = z.string().uuid().refine((value) => value[14] === '7');
const ReplaySchema = z.strictObject({
  eventId: UuidV7Schema,
  reason: z.enum(['destination_recovery', 'incident_response']),
});
const CrashIdSchema = z.strictObject({ crashId: UuidV7Schema });
const CrashAccessQuerySchema = z.strictObject({
  reason: z.enum(['customer_support', 'incident_response']),
});
const EuIssueQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const CrashFreeSchema = z.strictObject({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});
const TelemetryOperationalSnapshotSchema = z.strictObject({
  acceptedPending: z.number().int().nonnegative(),
  acceptedTerminal: z.number().int().nonnegative(),
  crashPending: z.number().int().nonnegative(),
  crashTerminal: z.number().int().nonnegative(),
  profilePending: z.number().int().nonnegative(),
  profileTerminal: z.number().int().nonnegative(),
  rejectionCount: z.number().int().nonnegative(),
  openCircuits: z.number().int().nonnegative(),
  oldestAcceptedAgeSeconds: z.number().int().nonnegative().nullable(),
  oldestCrashAgeSeconds: z.number().int().nonnegative().nullable(),
  oldestProfileAgeSeconds: z.number().int().nonnegative().nullable(),
});
const ReplayResponseSchema = z.strictObject({
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
});
const EuCrashIssueSchema = z.strictObject({
  fingerprint: z.string().min(1),
  firstSeen: z.string().datetime({ offset: true }),
  lastSeen: z.string().datetime({ offset: true }),
  count: z.number().int().nonnegative(),
  releases: z.array(z.string()),
});
const EuCrashIssuesResponseSchema = z.strictObject({
  issues: z.array(EuCrashIssueSchema),
});
const EuCrashFreeSegmentSchema = z.strictObject({
  release: z.string(),
  platform: z.string(),
  architecture: z.string(),
  channel: z.string(),
  eligibleLaunches: z.number().int().nonnegative(),
  crashedLaunches: z.number().int().nonnegative(),
  crashFreeLaunches: z.number().int().nonnegative(),
  uncorrelatedCrashes: z.number().int().nonnegative(),
});
const EuCrashFreeResponseSchema = z.strictObject({
  segments: z.array(EuCrashFreeSegmentSchema),
});

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
