import { readFileSync } from "node:fs";

import {
  SOCKET_TICKET_SUBPROTOCOL,
  openSubstreamSocket,
  socketTicketProtocols,
  socketUrlWithoutTicket,
} from "./substream-socket-client.mjs";

const baseUrl = process.env.AVALON_SMOKE_BASE_URL ?? "http://127.0.0.1:8787";
const otherBaseUrl = process.env.AVALON_SMOKE_OTHER_BASE_URL;
const expectedWebOrigin = process.env.AVALON_SMOKE_PUBLIC_WEB_ORIGIN ?? "http://127.0.0.1:5174";
const seedProduct = JSON.parse(readFileSync(new URL("../packages/db/seed-product.json", import.meta.url), "utf8"));
const seedChat = seedProduct.canvases.find((canvas) => canvas.title === "Q4 revenue review");
const seedChatCanvasId = seedChat.id;
const seedLaunchPlanId = seedProduct.canvases.find((canvas) => canvas.title === "Launch plan").id;
const seedSidekickId = seedProduct.automations[0].id;
// The dev user's own opening message, replayed by its client id below.
const seedOpening = seedChat.messages.find(
  (message) => message.client_message_id && message.author_user_id === seedChat.createdByUserId,
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function jsonRequest(path, options = {}, origin = baseUrl) {
  const response = await fetch(new URL(path, origin), options);
  const body = await response.json().catch(() => null);
  return { response, body };
}

const health = await jsonRequest("/health");
assert(health.response.ok && health.body?.ok === true, "Local Worker health check failed");

const session = await jsonRequest("/auth/dev/session", { method: "POST" });
assert(session.response.status === 201 && session.body?.accessToken, "Development sign-in failed");
const authHeaders = {
  authorization: `Bearer ${session.body.accessToken}`,
  "content-type": "application/json",
};

const protectedPaths = ["/workspace", "/automations", "/connections"];
for (const path of protectedPaths) {
  const result = await jsonRequest(path, { headers: authHeaders });
  assert(result.response.ok, `${path} returned ${result.response.status}`);
}

if (otherBaseUrl) {
  const crossRegion = await jsonRequest("/workspace", { headers: authHeaders }, otherBaseUrl);
  assert(
    crossRegion.response.status === 409 || crossRegion.response.status === 401,
    "A session was accepted by the other regional API",
  );
  assert(
    crossRegion.body?.error?.code === "region_mismatch" || crossRegion.body?.error?.code === "invalid_session",
    "Cross-region access did not reject the foreign session",
  );
}

const workspace = await jsonRequest("/workspace", { headers: authHeaders });
const expectedRegion = health.body?.region;
assert(workspace.body?.region === expectedRegion, "The organization was not bound to the API's region");

const wrongRegion = "unconfigured-deployment";
const wrongRegionRequest = await jsonRequest("/health", {
  headers: { "x-avalon-region": wrongRegion },
});
assert(wrongRegionRequest.response.status === 409, "The API accepted an explicit request for the wrong region");
assert(wrongRegionRequest.body?.error?.code === "region_mismatch", "Wrong-region access did not report a region mismatch");

const inviteEmail = `regional-smoke-${expectedRegion}@example.test`;
const firstInvitation = await jsonRequest("/workspace/invitations", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ email: inviteEmail, role: "member" }),
});
assert(firstInvitation.response.status === 201, "Invitation creation failed");
const firstInviteUrl = new URL(firstInvitation.body?.inviteUrl);
assert(firstInviteUrl.origin === expectedWebOrigin, "Invitation uses the wrong public origin");
assert(firstInviteUrl.pathname === "/invite/", "Invitation uses the wrong landing page");
assert(firstInviteUrl.search === "", "Invitation token leaked into the URL query string");
const firstInviteParameters = new URLSearchParams(firstInviteUrl.hash.slice(1));
const firstToken = firstInviteParameters.get("token");
assert(firstInviteParameters.get("region") === expectedRegion && firstToken, "Invitation fragment is incomplete");

const preview = await jsonRequest(`/auth/invitations/preview?token=${encodeURIComponent(firstToken)}`);
assert(preview.response.ok, "Invitation preview failed");
assert(preview.body?.region === expectedRegion, "Invitation preview returned the wrong region");
assert(preview.body?.email === inviteEmail, "Invitation preview returned the wrong email");

const rotatedInvitation = await jsonRequest("/workspace/invitations", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ email: inviteEmail, role: "member" }),
});
assert(rotatedInvitation.response.status === 201, "Invitation rotation failed");
const rotatedInviteUrl = new URL(rotatedInvitation.body?.inviteUrl);
const rotatedToken = new URLSearchParams(rotatedInviteUrl.hash.slice(1)).get("token");
assert(rotatedToken && rotatedToken !== firstToken, "Invitation rotation reused the old token");
const oldPreview = await jsonRequest(`/auth/invitations/preview?token=${encodeURIComponent(firstToken)}`);
assert(oldPreview.response.status === 404, "Rotating an invitation did not invalidate its prior token");

const invitationList = await jsonRequest("/workspace/invitations", { headers: authHeaders });
assert(invitationList.response.ok, "Invitation history failed to load");
assert(
  invitationList.body?.items?.some((item) => item.id === rotatedInvitation.body?.invitation?.id && item.status === "pending"),
  "The pending invitation is missing from organization settings",
);

const revoked = await jsonRequest(`/workspace/invitations/${rotatedInvitation.body?.invitation?.id}`, {
  method: "DELETE",
  headers: authHeaders,
});
assert(revoked.response.status === 204, "Invitation revocation failed");
const revokedPreview = await jsonRequest(`/auth/invitations/preview?token=${encodeURIComponent(rotatedToken)}`);
assert(revokedPreview.response.status === 404, "A revoked invitation remained usable");

// The seeded Canvases (`packages/db/seed-product.json`, imported by
// `pnpm db:open-authority`): Launch plan holds the fixture artifact, and Q4
// revenue review's Chat holds the dev user's opening message and Rally's reply.
const launchPlan = await jsonRequest(`/canvases/${seedLaunchPlanId}`, { headers: authHeaders });
assert(launchPlan.response.ok, "The seeded Launch plan Canvas is unavailable; run pnpm db:open-authority first");
assert(launchPlan.body?.artifacts?.length > 0, "The seeded Canvas artifact fixture is missing");

const chat = await jsonRequest(`/conversations/${seedChatCanvasId}`, { headers: authHeaders });
assert(chat.response.ok, "The seeded Canvas Chat is unavailable; run pnpm db:open-authority first");
const transcriptTurns = [
  ...(chat.body?.transcript?.ranges ?? []).flatMap((range) => range.turns ?? []),
  ...(chat.body?.transcript?.activeTurns ?? []),
];
assert(transcriptTurns.length >= seedChat.messages.length, "The seeded Canvas Chat transcript is incomplete");
assert(
  transcriptTurns.some((turn) => turn.actor === "assistant" && turn.blocks?.some((block) => block.type === "text")),
  "The seeded Canvas Chat has no reply from Rally",
);

const sidekickConversation = await jsonRequest(`/conversations/${seedSidekickId}`, { headers: authHeaders });
assert(sidekickConversation.response.ok, "The seeded Sidekick's shared conversation is unavailable");

// A Canvas this check makes, under an id it minted: a retried create answers
// the same Canvas, and a message resent to its Chat lands there once.
const canvasId = crypto.randomUUID();
const createCanvas = () => jsonRequest("/canvases", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ canvasId }),
});
const created = await createCanvas();
assert(
  created.response.status === 201 && created.body?.canvasId === canvasId,
  `Canvas creation returned ${created.response.status}`,
);
const retried = await createCanvas();
assert(
  retried.response.status === 201 && retried.body?.canvasId === canvasId,
  "A retried Canvas create did not answer the same Canvas",
);
const smokeMessage = { text: "Reply with exactly the word PONG.", clientMessageId: `smoke-${canvasId}` };
const sendSmokeMessage = () => jsonRequest(`/conversations/${canvasId}/substreams/0/messages`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify(smokeMessage),
});
const sent = await sendSmokeMessage();
assert(sent.response.status === 201 && sent.body?.turn?.turnId, `Canvas Chat message returned ${sent.response.status}`);
const resent = await sendSmokeMessage();
assert(resent.body?.turn?.turnId === sent.body.turn.turnId, "A resent Canvas Chat message answered a different turn");
const afterResend = await jsonRequest(`/conversations/${canvasId}`, { headers: authHeaders });
const copies = new Set([
  ...(afterResend.body?.transcript?.ranges ?? []).flatMap((range) => range.turns ?? []),
  ...(afterResend.body?.transcript?.activeTurns ?? []),
].filter((turn) => turn.clientMessageId === smokeMessage.clientMessageId).map((turn) => turn.turnId));
assert(copies.size === 1, `A resent Canvas Chat message landed ${copies.size} times`);

// With a model, Rally answers the Chat; without one the check says it did not look.
const modelConfigured = health.body?.checks?.openRouter?.ok === true
  && health.body.checks.openRouter.message === "configured";
let canvasReply = "not checked (no model configured)";
if (modelConfigured) {
  const deadline = Date.now() + 90_000;
  let reply = null;
  let status = null;
  while (Date.now() < deadline && reply === null) {
    const read = await jsonRequest(`/conversations/${canvasId}`, { headers: authHeaders });
    status = read.body?.latestHarnessRun?.status ?? null;
    const turns = [
      ...(read.body?.transcript?.ranges ?? []).flatMap((range) => range.turns ?? []),
      ...(read.body?.transcript?.activeTurns ?? []),
    ];
    reply = turns.filter((turn) => turn.actor === "assistant")
      .map((turn) => (turn.blocks ?? []).filter((block) => block.type === "text").map((block) => block.text).join(""))
      .find((text) => text.length > 0) ?? null;
    if (reply === null && ["failed", "stopped"].includes(status)) break;
    if (reply === null) await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  assert(reply !== null, `Rally did not reply in the new Canvas's Chat (run ${status ?? "never started"})`);
  canvasReply = "received";
}

const ticket = await jsonRequest(
  `/conversations/${seedChatCanvasId}/substreams/0/socket`,
  { headers: authHeaders },
);
assert(ticket.response.ok && ticket.body?.url && ticket.body?.ticket, "Realtime ticket creation failed");
// The desktop presents its ticket the way the renderer does: through the
// handshake subprotocol, with the deprecated query ticket stripped from the URL.
const handshakeUrl = socketUrlWithoutTicket(ticket.body.url);
assert(!handshakeUrl.includes("ticket="), "The handshake URL still carries the ticket");
const firstSocket = await openSubstreamSocket(handshakeUrl, {
  expectOpen: true,
  protocols: socketTicketProtocols(ticket.body.ticket),
  subscriptionBootstrap: ticket.body.subscriptionBootstrap ?? false,
  timeoutMs: 5_000,
  command: {
    type: "create_message",
    operationId: crypto.randomUUID(),
    payload: {
      text: seedOpening.text_content,
      clientMessageId: seedOpening.client_message_id,
      mentions: [],
      confirmedParticipantUserIds: [],
      attachmentIds: [],
    },
  },
});
assert(firstSocket.snapshot, "Realtime connection did not provide a snapshot");
assert(
  firstSocket.negotiated === SOCKET_TICKET_SUBPROTOCOL,
  `The server selected ${firstSocket.negotiated || "no subprotocol"} rather than the sentinel`,
);
assert(firstSocket.commandResult?.type === "client_command_succeeded", "Message idempotency replay failed");
assert(
  firstSocket.commandResult?.turn?.turnId === seedOpening.id,
  "Message replay created a duplicate",
);
assert(
  firstSocket.commandResult?.deliveryState === "canonical",
  "Message replay did not report its canonical durable state",
);

const replaySocket = await openSubstreamSocket(handshakeUrl, {
  expectOpen: false,
  protocols: socketTicketProtocols(ticket.body.ticket),
  subscriptionBootstrap: ticket.body.subscriptionBootstrap ?? false,
  timeoutMs: 5_000,
});
assert(!replaySocket.opened, "Realtime ticket replay was accepted");
assert(
  replaySocket.status === 401,
  `A replayed ticket was refused with ${replaySocket.status ?? "no status"} rather than 401`,
);

console.log(JSON.stringify({
  health: "ok",
  protectedEndpoints: protectedPaths.length,
  organizationRegion: expectedRegion,
  invitationLifecycle: "ok",
  crossRegionSession: otherBaseUrl ? "rejected" : "not checked",
  seededCanvases: "ok",
  canvasCreateRetry: "same Canvas",
  canvasChatMessage: "landed once",
  canvasReply,
  messageIdempotency: "ok",
  firstSocket: "snapshot",
  socketTransport: SOCKET_TICKET_SUBPROTOCOL,
  replaySocket: "rejected 401",
}));
