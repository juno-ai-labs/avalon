import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import {
  AnonymousTelemetryBatchSchema,
  CrashIngestResponseSchema,
  LinkAnonymousTelemetryResponseSchema,
  LinkAnonymousTelemetrySchema,
  TelemetryBatchSchema,
  TelemetryBootstrapRequestSchema,
  TelemetryBootstrapResponseSchema,
  TelemetryRouteResponseSchema,
  TelemetryAcceptanceBatchResponseSchema,
  ProductAnalyticsPreferenceSchema,
  UpdateProductAnalyticsPreferenceSchema,
  TelemetryBreadcrumbSidecarSchema,
  TELEMETRY_BATCH_MAX_BYTES,
} from "@rally/contracts/telemetry";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { getIdentityAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { acceptAuthenticatedTelemetry } from "../telemetry/authenticated";
import { TelemetryBootstrapService } from "../telemetry/bootstrap";
import { CrashIngestService } from "../telemetry/crash-ingest";
import { purgeIneligibleCrashReports } from "../telemetry/crash-delivery";
import { ProductAnalyticsPreferenceService } from "../telemetry/preference";
import { linkAnonymousTelemetry } from "../telemetry/identity-link";
import { z } from "zod";
import { consumeTelemetryRateLimit } from '../telemetry/operations';

export const publicTelemetryRoutes = new Hono<HonoAppEnv>();
export const authenticatedTelemetryRoutes = new Hono<HonoAppEnv>();

const telemetryBatchBodyLimit = bodyLimit({
  maxSize: TELEMETRY_BATCH_MAX_BYTES,
  onError: () => {
    throw new ApiError(413, "telemetry_payload_too_large", "The telemetry payload is too large");
  },
});

const crashUploadBodyLimit = bodyLimit({
  // Leaves bounded multipart framing room around the 20 MiB minidump and
  // 32 KiB breadcrumb sidecar. Missing/chunked Content-Length is counted while
  // the request stream is consumed rather than trusted as zero.
  maxSize: 21 * 1024 * 1024,
  onError: () => {
    throw new ApiError(413, 'crash_dump_too_large', 'The crash report is too large');
  },
});

publicTelemetryRoutes.get("/route", async (c) => {
  if (c.env.AVALON_REGION !== "global") {
    throw new ApiError(404, "not_found", "The requested API route does not exist");
  }
  const cf = c.req.raw.cf as { country?: string } | undefined;
  c.header("Cache-Control", "no-store");
  return c.json(TelemetryRouteResponseSchema.parse(
    await new TelemetryBootstrapService(c.env).route(cf?.country),
  ));
});

const CrashUploadMetadataSchema = z.object({
  uploadId: z.string().uuid().refine((value) => value[14] === "7"),
  installationId: z.string().uuid().refine((value) => value[14] === "7"),
  route: z.enum(["global", "eu"]),
  release: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._+-]+$/u),
  buildId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._+-]+$/u),
  platform: z.enum(["darwin", "win32", "linux"]),
  architecture: z.enum(["arm64", "x64"]),
  processRole: z.enum(["main", "renderer", "utility", "gpu", "unknown"]),
  launchId: z.string().uuid().refine((value) => value[14] === "7"),
  channel: z.enum(["development", "alpha", "beta", "stable"]),
}).strict();

export async function parseCrashUpload(c: Context<HonoAppEnv>) {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw new ApiError(400, "crash_upload_invalid", "The crash report is invalid");
  }
  if (form.getAll("dump").length !== 1 || form.getAll("metadata").length !== 1
    || form.getAll("breadcrumbs").length > 1
    || [...form.keys()].some((key) => !["dump", "metadata", "breadcrumbs"].includes(key))) {
    throw new ApiError(400, "crash_upload_invalid", "The crash report is invalid");
  }
  const dump = form.get("dump");
  const encodedMetadata = form.get("metadata");
  const encodedBreadcrumbs = form.get("breadcrumbs");
  if (!(dump instanceof File) || typeof encodedMetadata !== "string" || encodedMetadata.length > 4_096) {
    throw new ApiError(400, "crash_upload_invalid", "The crash report is invalid");
  }
  let metadata: z.infer<typeof CrashUploadMetadataSchema>;
  try {
    metadata = CrashUploadMetadataSchema.parse(JSON.parse(encodedMetadata) as unknown);
  } catch {
    throw new ApiError(400, "crash_upload_invalid", "The crash report is invalid");
  }
  let breadcrumbs: z.infer<typeof TelemetryBreadcrumbSidecarSchema> | undefined;
  if (encodedBreadcrumbs !== null) {
    if (typeof encodedBreadcrumbs !== "string" || encodedBreadcrumbs.length > 32 * 1024) {
      throw new ApiError(400, "crash_upload_invalid", "The crash report is invalid");
    }
    try {
      breadcrumbs = TelemetryBreadcrumbSidecarSchema.parse(JSON.parse(encodedBreadcrumbs) as unknown);
    } catch {
      throw new ApiError(400, "crash_upload_invalid", "The crash report is invalid");
    }
  }
  const bytes = new Uint8Array(await dump.arrayBuffer());
  return { metadata, bytes, breadcrumbs };
}

function crashApiError(error: unknown): never {
  const code = error instanceof Error ? error.message : "crash_upload_invalid";
  if (code === "crash_dump_too_large") throw new ApiError(413, code, "The crash report is too large");
  if (code === "crash_rate_limited") throw new ApiError(429, code, "Too many crash reports were uploaded");
  if (code === "crash_upload_conflict") throw new ApiError(409, code, "The crash upload ID was already used");
  if (code === "crash_route_mismatch" || code === "crash_route_forbidden") {
    throw new ApiError(403, code, "The crash report cannot be accepted in this region");
  }
  const publicCodes = new Set([
    'crash_dump_malformed',
    'crash_upload_invalid',
    'telemetry_capability_expired',
    'telemetry_capability_invalid',
  ]);
  if (publicCodes.has(code)) throw new ApiError(400, code, "The crash report is invalid");
  throw new ApiError(500, 'internal_error', 'The crash report could not be processed');
}

function anonymousTelemetryApiError(error: unknown): never {
  const code = error instanceof Error ? error.message : 'telemetry_anonymous_invalid';
  if (code === 'telemetry_capability_invalid' || code === 'telemetry_capability_expired') {
    throw new ApiError(401, code, 'The telemetry capability is invalid or expired');
  }
  if (code === 'telemetry_anonymous_event_forbidden') {
    throw new ApiError(403, code, 'The telemetry event is not allowed before regional setup');
  }
  if (code === 'telemetry_eu_bridge_unavailable') {
    throw new ApiError(503, code, 'Regional telemetry is temporarily unavailable');
  }
  throw new ApiError(500, 'internal_error', 'The telemetry event could not be processed');
}

publicTelemetryRoutes.post(
  "/bootstrap",
  zValidator("json", TelemetryBootstrapRequestSchema),
  async (c) => {
    if (c.env.AVALON_REGION !== "global") {
      throw new ApiError(404, "not_found", "The requested API route does not exist");
    }
    const cf = c.req.raw.cf as { country?: string } | undefined;
    const edgeAddress = c.req.header('cf-connecting-ip');
    if (edgeAddress && !await consumeTelemetryRateLimit(
      c.env,
      'telemetry_bootstrap',
      edgeAddress,
      30,
    )) throw new ApiError(429, 'telemetry_bootstrap_rate_limited', 'Too many telemetry sessions were requested');
    let response: z.infer<typeof TelemetryBootstrapResponseSchema>;
    try {
      response = await new TelemetryBootstrapService(c.env).bootstrap(
        c.req.valid("json").anonymousEpochId,
        cf?.country,
        c.req.valid("json").routeToken,
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : 'telemetry_bootstrap_failed';
      if (code === 'telemetry_journey_closed') {
        throw new ApiError(409, code, 'The onboarding telemetry journey is closed');
      }
      if (code === 'telemetry_route_decision_conflict') {
        throw new ApiError(409, code, 'The telemetry route changed before the journey started');
      }
      if (code === 'telemetry_route_decision_invalid' || code === 'telemetry_route_decision_expired') {
        throw new ApiError(400, code, 'The telemetry route decision is invalid or expired');
      }
      throw new ApiError(500, 'internal_error', 'Telemetry routing could not be resolved');
    }
    c.header("Cache-Control", "no-store");
    return c.json(TelemetryBootstrapResponseSchema.parse(response), 201);
  },
);

publicTelemetryRoutes.post("/crashes/anonymous", crashUploadBodyLimit, async (c) => {
  const capability = readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.TELEMETRY_CAPABILITY);
  if (!capability) throw new ApiError(401, "telemetry_capability_required", "A telemetry capability is required");
  let authorization: { route: "global"; anonymousEpochId: string; journeyId: string };
  try {
    authorization = await new TelemetryBootstrapService(c.env).authorizeCrash(capability);
  } catch (error) {
    return crashApiError(error);
  }
  const upload = await parseCrashUpload(c);
  if (upload.metadata.route !== authorization.route) {
    throw new ApiError(403, "crash_route_mismatch", "The crash report cannot be accepted in this region");
  }
  try {
    return c.json(CrashIngestResponseSchema.parse(await new CrashIngestService(c.env).accept({
      ...upload.metadata,
      dump: upload.bytes,
      ...(upload.breadcrumbs ? { breadcrumbs: upload.breadcrumbs } : {}),
      subjectUserId: null,
      rateLimitSubject: `journey:${authorization.journeyId}`,
    })), 202);
  } catch (error) {
    return crashApiError(error);
  }
});

publicTelemetryRoutes.post(
  "/anonymous",
  telemetryBatchBodyLimit,
  zValidator("json", AnonymousTelemetryBatchSchema),
  async (c) => {
    if (c.env.AVALON_REGION !== "global") {
      throw new ApiError(404, "not_found", "The requested API route does not exist");
    }
    const body = c.req.valid("json");
    let results: z.infer<typeof TelemetryAcceptanceBatchResponseSchema>['results'];
    try {
      results = await new TelemetryBootstrapService(c.env).accept(
        body.capability,
        body.events,
        body.installationId,
      );
    } catch (error) {
      return anonymousTelemetryApiError(error);
    }
    return c.json(TelemetryAcceptanceBatchResponseSchema.parse({ results }), 202);
  },
);

authenticatedTelemetryRoutes.post(
  "/events",
  telemetryBatchBodyLimit,
  zValidator("json", TelemetryBatchSchema),
  async (c) => {
    const batch = c.req.valid("json");
    // The public contract has to parse API events so internal producers can
    // build one envelope type, but the desktop transport is not that producer.
    // Accepting `source: api` here would let a modified client forge every
    // authoritative completion event while retaining a valid user session.
    if (batch.events.some((event) => event.source === "api")) {
      throw new ApiError(403, "telemetry_source_forbidden", "The telemetry source is not allowed");
    }
    return c.json(TelemetryAcceptanceBatchResponseSchema.parse({
      results: await acceptAuthenticatedTelemetry(c.env, getIdentityAuth(c), batch),
    }), 202);
  },
);

authenticatedTelemetryRoutes.post(
  "/link-anonymous",
  zValidator("json", LinkAnonymousTelemetrySchema),
  async (c) => {
    try {
      return c.json(LinkAnonymousTelemetryResponseSchema.parse(await linkAnonymousTelemetry(
        c.env,
        getIdentityAuth(c),
        c.req.valid("json").capability,
      )));
    } catch (error) {
      const code = error instanceof Error ? error.message : "telemetry_link_invalid";
      if (code === "telemetry_link_conflict") {
        throw new ApiError(409, code, "The anonymous analytics epoch is already linked");
      }
      if (code === 'telemetry_link_route_mismatch') {
        throw new ApiError(403, code, 'The anonymous analytics epoch belongs to another region');
      }
      if (code === 'telemetry_capability_invalid' || code === 'telemetry_capability_expired'
        || code === 'telemetry_journey_closed') {
        throw new ApiError(400, code, 'The anonymous analytics epoch could not be linked');
      }
      if (code === 'telemetry_control_unavailable') {
        throw new ApiError(503, code, 'Anonymous analytics linking is temporarily unavailable');
      }
      throw new ApiError(500, 'internal_error', 'The anonymous analytics epoch could not be linked');
    }
  },
);

authenticatedTelemetryRoutes.post("/crashes", crashUploadBodyLimit, async (c) => {
  const upload = await parseCrashUpload(c);
  const auth = getIdentityAuth(c);
  try {
    return c.json(CrashIngestResponseSchema.parse(await new CrashIngestService(c.env).accept({
      ...upload.metadata,
      dump: upload.bytes,
      ...(upload.breadcrumbs ? { breadcrumbs: upload.breadcrumbs } : {}),
      subjectUserId: auth.userId,
      subjectWorkspaceId: auth.workspaceId,
      rateLimitSubject: `user:${auth.userId}`,
    })), 202);
  } catch (error) {
    return crashApiError(error);
  }
});

authenticatedTelemetryRoutes.get("/preference", async (c) => {
  const auth = getIdentityAuth(c);
  const row = await c.env.DB.prepare(
    `SELECT product_analytics_enabled, product_analytics_preference_version
     FROM users WHERE id = ?`,
  ).bind(auth.userId).first<{
    product_analytics_enabled: number;
    product_analytics_preference_version: number;
  }>();
  if (!row) throw new ApiError(401, "session_revoked", "The session is no longer active");
  c.header("Cache-Control", "no-store");
  return c.json(ProductAnalyticsPreferenceSchema.parse({
    enabled: row.product_analytics_enabled === 1,
    version: row.product_analytics_preference_version,
  }));
});

authenticatedTelemetryRoutes.patch(
  "/preference",
  zValidator("json", UpdateProductAnalyticsPreferenceSchema),
  async (c) => {
    const auth = getIdentityAuth(c);
    const body = c.req.valid("json");
    const preference = await new ProductAnalyticsPreferenceService(c.env, auth.userId).update(body);
    if (!body.enabled) {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `DELETE FROM telemetry_accepted_events
           WHERE subject_user_id = ? AND delivery_state IN ('pending', 'retrying')
             AND json_extract(envelope_json, '$.category') IN ('product', 'diagnostic')
             AND EXISTS (
               SELECT 1 FROM users WHERE id = ? AND product_analytics_enabled = 0
                 AND product_analytics_preference_version = ?
             )`,
        ).bind(auth.userId, auth.userId, preference.version),
        c.env.DB.prepare(
          `DELETE FROM telemetry_profile_jobs
           WHERE subject_user_id = ? AND state IN ('pending', 'delivering')
             AND EXISTS (
               SELECT 1 FROM users WHERE id = ? AND product_analytics_enabled = 0
                 AND product_analytics_preference_version = ?
             )`,
        ).bind(auth.userId, auth.userId, preference.version),
      ]);
      await purgeIneligibleCrashReports(c.env, auth.userId);
    }
    return c.json(ProductAnalyticsPreferenceSchema.parse(preference));
  },
);
