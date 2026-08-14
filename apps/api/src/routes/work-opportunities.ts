import {
  IdSchema,
  RecordWorkOpportunityImpressionsRequestSchema,
  StartWorkOpportunityRequestSchema,
  WorkOpportunityPageSchema,
  WorkstreamSchema,
} from "@avalon/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { newId } from "@avalon/db";
import type { HonoAppEnv } from "../env";
import { requestDeferral } from "../lib/defer";
import { getAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { WorkOpportunityService } from "../services/work-opportunity-service";
import { apiTelemetryEnvelope, emitAuthenticatedApiTelemetry } from "../telemetry/api-emitter";
import {
  emitProductUsageTelemetry,
  resourceTelemetryEventId,
  telemetryCountBucket,
  telemetryJourneyDuration,
} from "../telemetry/product-usage";

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(4).default(4) });
const idParam = z.object({ id: IdSchema });
const suggestionActionQuery = z.object({
  surface: z.enum(["menu_bar", "workspace_home"]).optional(),
  version: z.coerce.number().int().positive().optional(),
  position: z.coerce.number().int().min(1).max(4).optional(),
});

const CONNECTOR_TYPES = new Set(["github", "google", "granola", "linear", "notion", "slack", "x", "generic_webhook"]);

async function suggestionTelemetryContext(env: HonoAppEnv["Bindings"], auth: ReturnType<typeof getAuth>, id: string) {
  const [row, providers] = await Promise.all([
    env.DB.prepare(
      `SELECT o.version, o.audience_scope, o.created_at, s.impression_count, s.first_impressed_at
       FROM work_opportunities o
       LEFT JOIN work_opportunity_user_states s ON s.opportunity_id = o.id AND s.user_id = ?
       WHERE o.id = ? AND o.workspace_id = ? LIMIT 1`,
    ).bind(auth.userId, id, auth.workspaceId).first<Record<string, unknown>>(),
    env.DB.prepare(
      `WITH RECURSIVE provenance(id, provider, depth) AS (
         SELECT n.id, n.provider, 0 FROM work_opportunity_provenance_roots r
         JOIN opportunity_provenance_nodes n ON n.id = r.node_id WHERE r.opportunity_id = ?
         UNION ALL
         SELECT n.id, n.provider, provenance.depth + 1 FROM provenance
         JOIN opportunity_provenance_edges e ON e.parent_node_id = provenance.id
         JOIN opportunity_provenance_nodes n ON n.id = e.child_node_id
         WHERE provenance.depth < 3
       ) SELECT DISTINCT provider FROM provenance WHERE provider IS NOT NULL LIMIT 16`,
    ).bind(id).all<{ provider: string }>(),
  ]);
  if (!row) return null;
  return {
    version: Number(row.version),
    audienceScope: row.audience_scope === "workspace" ? "workspace" as const : "personal" as const,
    createdAt: String(row.created_at),
    impressionCount: Number(row.impression_count ?? 0),
    firstImpressedAt: row.first_impressed_at == null ? null : String(row.first_impressed_at),
    connectorTypes: [...new Set(providers.results.map(({ provider }) => provider)
      .filter((provider) => CONNECTOR_TYPES.has(provider)))].sort() as Array<
        "github" | "google" | "granola" | "linear" | "notion" | "slack" | "x" | "generic_webhook"
      >,
  };
}

function suggestionFreshness(createdAt: string): "lt_1h" | "1h_24h" | "1d_7d" | "gte_7d" {
  const age = Math.max(0, Date.now() - Date.parse(createdAt));
  if (age < 60 * 60 * 1_000) return "lt_1h";
  if (age < 24 * 60 * 60 * 1_000) return "1h_24h";
  if (age < 7 * 24 * 60 * 60 * 1_000) return "1d_7d";
  return "gte_7d";
}

/**
 * What starting a suggestion hands back: the work stream it opened, and where.
 *
 * `WorkstreamSchema`, not `WorkstreamDetailSchema`. The two exits of
 * `WorkOpportunityService.start` return different shapes — a replay reloads the
 * detail, a fresh start returns what `workstreams.create` built — and the detail
 * schema's `participants`/`resources`/`suggestions` carry no defaults, so
 * demanding it here 500s the fresh-start path after the work stream, its email
 * route and its harness run have all committed. The desktop client parses this
 * response with the base schema, so the detail's extra keys were never read.
 */
export const StartedWorkOpportunityResponseSchema = z.object({
  workstream: WorkstreamSchema,
  messageId: IdSchema,
  harnessRunId: IdSchema.nullable(),
});

export const workOpportunityRoutes = new Hono<HonoAppEnv>();

workOpportunityRoutes.get("/", zValidator("query", listQuery), async (c) =>
  c.json(WorkOpportunityPageSchema.parse(
    await new WorkOpportunityService(c.env, getAuth(c), requestDeferral(c)).list(c.req.valid("query").limit))),
);

workOpportunityRoutes.post(
  "/impressions",
  zValidator("json", RecordWorkOpportunityImpressionsRequestSchema),
  async (c) => {
    const input = c.req.valid("json");
    const auth = getAuth(c);
    await new WorkOpportunityService(c.env, auth).recordImpressions(input.opportunityIds);
    await Promise.all(input.opportunityIds.map(async (opportunityId, index) => {
      const context = await suggestionTelemetryContext(c.env, auth, opportunityId);
      if (!context) return;
      await emitProductUsageTelemetry(c.env, {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        name: "suggested_work_impression",
        properties: {
          opportunityId,
          version: context.version,
          surface: input.surface,
          position: index + 1,
          audienceScope: context.audienceScope,
          connectorTypes: context.connectorTypes,
          freshness: suggestionFreshness(context.createdAt),
          priorImpressionCount: telemetryCountBucket(Math.max(0, context.impressionCount - 1)),
        },
        operationId: opportunityId,
        eventId: newId(),
      }).catch(() => undefined);
    }));
    return c.body(null, 204);
  },
);

workOpportunityRoutes.delete("/:id", zValidator("param", idParam), zValidator("query", suggestionActionQuery), async (c) => {
  const id = c.req.valid("param").id;
  const input = c.req.valid("query");
  const auth = getAuth(c);
  const context = await suggestionTelemetryContext(c.env, auth, id);
  await new WorkOpportunityService(c.env, auth).dismiss(id);
  if (context && input.surface && input.position && (!input.version || input.version === context.version)) {
    await emitProductUsageTelemetry(c.env, {
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      name: "suggested_work_dismissed",
      properties: {
        opportunityId: id,
        version: context.version,
        surface: input.surface,
        position: input.position,
        audienceScope: context.audienceScope,
        connectorTypes: context.connectorTypes,
        timeSinceFirstImpression: context.firstImpressedAt
          ? telemetryJourneyDuration(Math.max(0, Date.now() - Date.parse(context.firstImpressedAt)))
          : "unknown",
      },
      operationId: id,
      eventId: resourceTelemetryEventId(id, 8),
    }).catch(() => undefined);
  }
  return c.body(null, 204);
});

workOpportunityRoutes.post(
  "/:id/start",
  zValidator("param", idParam),
  zValidator("json", StartWorkOpportunityRequestSchema),
  async (c) => {
    const input = c.req.valid("json");
    const auth = getAuth(c);
    const context = await suggestionTelemetryContext(c.env, auth, c.req.valid("param").id);
    const started = StartedWorkOpportunityResponseSchema.parse(
      await new WorkOpportunityService(c.env, auth, requestDeferral(c)).start(
        c.req.valid("param").id,
        input.version,
        input.idempotencyKey,
      ));
    const surface = input.surface;
    const hasDetailedContext = Boolean(context && surface && input.position);
    if (!hasDetailedContext) {
      try {
        requestDeferral(c)(Promise.resolve().then(async () => {
          const event = startedWorkOpportunityTelemetryEnvelope(
            c.env, surface, c.req.valid("param").id,
          );
          await emitAuthenticatedApiTelemetry(c.env, auth, event);
        }).catch(() => undefined));
      } catch {
        // Telemetry cannot change the already-completed product action.
      }
    }
    if (context && surface && input.position) {
      await emitProductUsageTelemetry(c.env, {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        name: "suggested_work_started_v2",
        properties: {
          opportunityId: c.req.valid("param").id,
          workstreamId: started.workstream.id,
          version: input.version,
          surface,
          position: input.position,
          audienceScope: context.audienceScope,
          connectorTypes: context.connectorTypes,
          priorImpressionCount: telemetryCountBucket(context.impressionCount),
        },
        operationId: c.req.valid("param").id,
        eventId: resourceTelemetryEventId(c.req.valid("param").id, 9),
      }).catch(() => undefined);
    }
    return c.json(StartedWorkOpportunityResponseSchema.parse(started), 201);
  },
);

export function startedWorkOpportunityTelemetryEnvelope(
  env: HonoAppEnv["Bindings"],
  surface: "menu_bar" | "workspace_home" | undefined,
  opportunityId: string,
) {
  return apiTelemetryEnvelope(
    env,
    "suggested_work_started",
    { surface: surface ?? "workspace_home" },
    opportunityId,
    "workspace-user",
    env.AVALON_REGION,
    opportunityId,
  );
}
