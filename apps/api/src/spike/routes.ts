/**
 * SPIKE — throwaway. Not production code, not on the release path.
 *
 * The dev-gated surface the spike script drives. Mounted under `/dev/spike`,
 * behind the same `APP_ENV === "development" && RALLY_DEV_AUTH === "true"` gate
 * every other `/dev` handler re-checks for itself.
 *
 * Note what these routes do **not** accept: a timestamp. The replay context is
 * internal, and every instant in the pack is derived inside `pack.ts` from the
 * seeding moment by a fixed offset. There is no way to hand a historical
 * instant to Rally over HTTP, which is the whole point of the constraint.
 */
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { asUserId, asWorkspaceId } from "@rally/contracts";
import { newId } from "@rally/db";

import { WorkstreamObjectClient } from "../services/workstream-object-client";
import { awaitWorkspaceDirectory, seedTidepointPack } from "./pack";
import { retireWorkspace, retirementState } from "./retirement";

export const spikeRoutes = new Hono<{ Bindings: Env }>();

function assertDevelopment(env: Env): void {
  if (env.APP_ENV !== "development" || env.RALLY_DEV_AUTH !== "true") {
    throw new ApiError(404, "not_found", "Development tooling is unavailable");
  }
}

const seedBody = z.strictObject({
  workspaceId: z.string().uuid(),
  presenterUserId: z.string().uuid(),
  presenterSessionId: z.string().min(1).max(200),
  documentTitle: z.string().min(1).max(180).optional(),
  only: z.array(z.enum(["A", "B", "C"])).optional(),
  skipClosingRun: z.boolean().optional(),
});

spikeRoutes.post("/seed", zValidator("json", seedBody), async (c) => {
  assertDevelopment(c.env);
  try {
    return c.json(await seedTidepointPack(c.env, c.req.valid("json")));
  } catch (error) {
    throw new ApiError(500, "spike_seed_failed",
      error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.slice(0, 2000) : "unknown");
  }
});

const retireBody = z.strictObject({
  workspaceId: z.string().uuid(),
  reason: z.string().min(1).max(120).default("spike_demo_reset"),
});

spikeRoutes.post("/retire", zValidator("json", retireBody), async (c) => {
  assertDevelopment(c.env);
  try {
    return c.json(await retireWorkspace(c.env, c.req.valid("json")));
  } catch (error) {
    throw new ApiError(500, "spike_retire_failed",
      error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.slice(0, 2000) : "unknown");
  }
});

const stateQuery = z.object({
  workspaceId: z.string().uuid(),
  workstreamIds: z.string().optional(),
});

spikeRoutes.get("/retirement-state", zValidator("query", stateQuery), async (c) => {
  assertDevelopment(c.env);
  const query = c.req.valid("query");
  return c.json(await retirementState(c.env, {
    workspaceId: query.workspaceId,
    workstreamIds: query.workstreamIds ? query.workstreamIds.split(",").filter(Boolean) : [],
  }));
});

/**
 * Post a message straight at a work stream's object, bypassing the edge.
 *
 * This is the only honest way to test that a *retired object* refuses a write:
 * `abandoned_at` makes the caller's session invalid, so an ordinary
 * `POST`-shaped attempt would be refused by auth middleware and prove nothing
 * about the object. This reaches `SubstreamAgent.handleProductRequest` with a
 * connector principal, exactly as a queue consumer would.
 */
const probeBody = z.strictObject({
  workspaceId: z.string().uuid(),
  workstreamId: z.string().uuid(),
  userId: z.string().uuid(),
  text: z.string().min(1).max(500),
});

spikeRoutes.post("/probe-write", zValidator("json", probeBody), async (c) => {
  assertDevelopment(c.env);
  const body = c.req.valid("json");
  const auth = {
    sessionId: `spike-probe:${body.userId}`,
    userId: asUserId(body.userId),
    workspaceId: asWorkspaceId(body.workspaceId),
    region: c.env.AVALON_REGION,
    role: "member" as const,
    principal: "connector" as const,
  };
  try {
    const receipt = await new WorkstreamObjectClient(
      c.env,
      auth as never,
      body.workstreamId,
      "0",
      ).createMessage({
      text: body.text,
      clientMessageId: newId(),
      mentions: [],
      confirmedParticipantUserIds: [],
      attachmentIds: [],
      // Same replay context the pack uses. Without it this write reaches the
      // addressing classifier, which is a model call the local stack cannot
      // make — so the probe would fail for a reason that has nothing to do with
      // whether the workspace is retired.
      spikeReplay: {
        occurredAt: Date.now(),
        packRunId: "00000000-0000-7000-8000-000000000000",
        actionId: "probe-write",
        workspaceId: body.workspaceId,
      },
    });
    return c.json({ refused: false, turnId: receipt.turn.turnId });
  } catch (error) {
    return c.json({
      refused: true,
      code: error instanceof ApiError ? error.code : "unknown",
      status: error instanceof ApiError ? error.status : null,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
});

/**
 * Answer an elicitation as the presenter.
 *
 * There is no REST route for this in Rally: `answer_elicitation` is a substream
 * *socket* command, and the only non-socket caller is the connector ingress.
 * This drives `SubstreamAgent`'s `answer_elicitation` product RPC — the same
 * operation the socket handler dispatches, through the fuller of its two
 * authorization paths — so the transport differs from a real client and nothing
 * else does.
 */
const answerBody = z.strictObject({
  workspaceId: z.string().uuid(),
  workstreamId: z.string().uuid(),
  elicitationId: z.string().uuid(),
  userId: z.string().uuid(),
  sessionId: z.string().min(1).max(200),
  answer: z.string().min(1).max(4000),
  customResponse: z.string().min(1).max(4000).optional(),
});

spikeRoutes.post("/answer-elicitation", zValidator("json", answerBody), async (c) => {
  assertDevelopment(c.env);
  const body = c.req.valid("json");
  const auth = {
    sessionId: body.sessionId,
    userId: asUserId(body.userId),
    workspaceId: asWorkspaceId(body.workspaceId),
    region: c.env.AVALON_REGION,
    role: "owner" as const,
  };
  const result = await new WorkstreamObjectClient(
    c.env,
    auth as never,
    body.workstreamId,
    "0",
  ).answerElicitation(
    body.elicitationId,
    {
      answer: body.answer,
      ...(body.customResponse ? { customResponse: body.customResponse } : {}),
    },
    // The resumed run replays a recorded closing answer. Without it the run
    // reaches a provider that is not configured here and settles as a failure
    // pill — which still proves the loop restarted, but proves nothing about
    // what history it read. The fixture provider logs the protocol array it was
    // handed (`spike_provider_history`), and that log line is the evidence.
    {
      occurredAt: Date.now(),
      packRunId: "00000000-0000-7000-8000-000000000000",
      actionId: "C:elicitation-answer",
      workspaceId: body.workspaceId,
      assistant: {
        plugins: [],
        elicitationTargetUserId: null,
        turns: [{
          kind: "say" as const,
          text: "Understood — I will write the renewal proposal against including "
            + "Insights at the $4k Growth uplift, and flag TID-431 as the blocker "
            + "for quoting it.",
        }],
      },
    },
  );
  return c.json({ elicitation: result.elicitation ?? null });
});

/**
 * Wait for a work stream to appear in the workspace directory.
 *
 * The push version of this — flush the child's outbox, flush the parent's, then
 * probe — is gone: both hops are Cloudflare Queues now and the flush methods
 * were deleted with the RPC. This is the read that replaced it.
 */
const drainBody = z.strictObject({
  workspaceId: z.string().uuid(),
  workstreamId: z.string().uuid(),
  viewerUserId: z.string().uuid(),
  budgetMs: z.number().int().min(1000).max(120_000).optional(),
});

spikeRoutes.post("/await-directory", zValidator("json", drainBody), async (c) => {
  assertDevelopment(c.env);
  const body = c.req.valid("json");
  return c.json(await awaitWorkspaceDirectory(
    c.env,
    body.workspaceId,
    body.workstreamId,
    body.viewerUserId,
    body.budgetMs ?? 30_000,
  ));
});
