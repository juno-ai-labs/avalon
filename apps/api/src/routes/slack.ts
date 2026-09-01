import { parseSlackEventEnvelope, verifySlackRequest } from "@rally/connectors";
import { Hono } from "hono";
import { z } from "zod/v3";
import type { HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { SlackAgentService } from "../services/slack-agent-service";
import { isSharedSlackIngress, SlackRoutingService } from "../services/slack-routing-service";

/**
 * These bodies go back to Slack rather than to an Avalon client, so the shapes
 * are Slack's: a URL-verification echo, and an acknowledgement whose contents
 * Slack defines. Bounding them here still stops an unrelated internal object
 * being handed to a third party by accident.
 */
const SlackChallengeResponseSchema = z.object({ challenge: z.string() });
const SlackAckResponseSchema = z.record(z.string(), z.unknown());

export const slackIngressRoutes = new Hono<HonoAppEnv>();

slackIngressRoutes.post("/events", async (c) => {
  const startedAt = Date.now();
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  const verified = await verify(c.env.SLACK_SIGNING_SECRET, rawBody, c.req.raw.headers);
  let payload: unknown;
  try {
    payload = JSON.parse(verified.body);
  } catch {
    throw new ApiError(400, "slack_payload_invalid", "Slack sent malformed JSON");
  }
  const envelope = parseSlackEventEnvelope(payload, c.env.SLACK_APP_ID);
  if (envelope.type === "url_verification") {
    return c.json(SlackChallengeResponseSchema.parse({ challenge: envelope.challenge ?? "" }));
  }
  const operation = isSharedSlackIngress(c.env, c.req.url)
    ? new SlackRoutingService(c.env).processEvent(payload, verified.bodyHash)
    : new SlackAgentService(c.env).processEvent(payload, verified.bodyHash);
  await slackOperationWithinAckDeadline(operation, startedAt, c.executionCtx);
  return c.json({ ok: true });
});

slackIngressRoutes.post("/interactivity", async (c) => {
  const startedAt = Date.now();
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  const verified = await verify(c.env.SLACK_SIGNING_SECRET, rawBody, c.req.raw.headers);
  const encoded = new URLSearchParams(verified.body).get("payload");
  if (!encoded) throw new ApiError(400, "slack_payload_invalid", "Slack interaction payload is missing");
  let payload: unknown;
  try {
    payload = JSON.parse(encoded);
  } catch {
    throw new ApiError(400, "slack_payload_invalid", "Slack sent a malformed interaction payload");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ApiError(400, "slack_payload_invalid", "Slack interaction payload is invalid");
  const interaction = payload as Record<string, unknown>;
  const operation = isSharedSlackIngress(c.env, c.req.url)
    ? new SlackRoutingService(c.env).processInteraction(interaction, verified.bodyHash)
    : new SlackAgentService(c.env).processInteraction(interaction, verified.bodyHash);
  return c.json(SlackAckResponseSchema.parse(
    await slackOperationWithinAckDeadline(operation, startedAt, c.executionCtx)));
});

slackIngressRoutes.post("/commands", async (c) => {
  const startedAt = Date.now();
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  const verified = await verify(c.env.SLACK_SIGNING_SECRET, rawBody, c.req.raw.headers);
  const form = Object.fromEntries(new URLSearchParams(verified.body).entries());
  const operation = isSharedSlackIngress(c.env, c.req.url)
    ? new SlackRoutingService(c.env).processCommand(form, verified.bodyHash)
    : new SlackAgentService(c.env).processCommand(form, verified.bodyHash);
  return c.json(SlackAckResponseSchema.parse(
    await slackOperationWithinAckDeadline(operation, startedAt, c.executionCtx)));
});

const SLACK_ACK_BUDGET_MS = 2_600;

async function slackOperationWithinAckDeadline<T>(
  operation: Promise<T>,
  startedAt: number,
  executionContext: { waitUntil(promise: Promise<unknown>): void },
): Promise<T> {
  // Keep the idempotent durable admission attempt alive if the regional path
  // misses Slack's response budget. The non-2xx response asks Slack to retry;
  // ingress job identity prevents a second execution.
  executionContext.waitUntil(operation.then(() => undefined, () => undefined));
  const remaining = SLACK_ACK_BUDGET_MS - (Date.now() - startedAt);
  if (remaining <= 0) {
    throw new ApiError(503, "slack_ack_deadline_exceeded", "Slack ingress could not be durably accepted before its acknowledgement deadline");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ApiError(
          503,
          "slack_ack_deadline_exceeded",
          "Slack ingress could not be durably accepted before its acknowledgement deadline",
        )), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function verify(signingSecret: string | undefined, body: Uint8Array, headers: Headers) {
  if (!signingSecret) throw new ApiError(503, "slack_unavailable", "Slack ingress is not configured");
  return verifySlackRequest({
    signingSecret,
    rawBody: body,
    timestamp: headers.get("x-slack-request-timestamp"),
    signature: headers.get("x-slack-signature"),
  });
}
