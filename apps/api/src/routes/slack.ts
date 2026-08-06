import { parseSlackEventEnvelope, verifySlackRequest } from "@avalon/connectors";
import { Hono } from "hono";
import type { HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { SlackAgentService } from "../services/slack-agent-service";
import { isSharedSlackIngress, SlackRoutingService } from "../services/slack-routing-service";

export const slackIngressRoutes = new Hono<HonoAppEnv>();

slackIngressRoutes.post("/events", async (c) => {
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  const verified = await verify(c.env.SLACK_SIGNING_SECRET, rawBody, c.req.raw.headers);
  let payload: unknown;
  try {
    payload = JSON.parse(verified.body);
  } catch {
    throw new ApiError(400, "slack_payload_invalid", "Slack sent malformed JSON");
  }
  const envelope = parseSlackEventEnvelope(payload, c.env.SLACK_APP_ID);
  if (envelope.type === "url_verification") return c.json({ challenge: envelope.challenge ?? "" });
  await (isSharedSlackIngress(c.env, c.req.url)
    ? new SlackRoutingService(c.env).processEvent(payload, verified.bodyHash)
    : new SlackAgentService(c.env).processEvent(payload, verified.bodyHash));
  return c.json({ ok: true });
});

slackIngressRoutes.post("/interactivity", async (c) => {
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
  return c.json(await operation);
});

slackIngressRoutes.post("/commands", async (c) => {
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  const verified = await verify(c.env.SLACK_SIGNING_SECRET, rawBody, c.req.raw.headers);
  const form = Object.fromEntries(new URLSearchParams(verified.body).entries());
  const operation = isSharedSlackIngress(c.env, c.req.url)
    ? new SlackRoutingService(c.env).processCommand(form, verified.bodyHash)
    : new SlackAgentService(c.env).processCommand(form, verified.bodyHash);
  return c.json(await operation);
});

async function verify(signingSecret: string | undefined, body: Uint8Array, headers: Headers) {
  if (!signingSecret) throw new ApiError(503, "slack_unavailable", "Slack ingress is not configured");
  return verifySlackRequest({
    signingSecret,
    rawBody: body,
    timestamp: headers.get("x-slack-request-timestamp"),
    signature: headers.get("x-slack-signature"),
  });
}
