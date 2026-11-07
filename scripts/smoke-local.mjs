import {
  SOCKET_TICKET_SUBPROTOCOL,
  openSubstreamSocket,
  socketTicketProtocols,
  socketUrlWithoutTicket,
} from "./substream-socket-client.mjs";

const baseUrl = process.env.AVALON_SMOKE_BASE_URL ?? "http://127.0.0.1:8787";
const otherBaseUrl = process.env.AVALON_SMOKE_OTHER_BASE_URL;
const expectedWebOrigin = process.env.AVALON_SMOKE_PUBLIC_WEB_ORIGIN ?? "http://127.0.0.1:5174";
const seedWorkstreamId = "00000000-0000-7000-8000-000000000021";

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

const detail = await jsonRequest(`/conversations/${seedWorkstreamId}`, { headers: authHeaders });
assert(detail.response.ok, "Seeded work-stream detail is unavailable; run pnpm db:seed first");
assert(detail.body?.resources?.length > 0, "The right-rail resource fixture is missing");
assert(detail.body?.connections?.length > 0, "The right-rail connection fixture is missing");

const transcriptTurns = [
  ...(detail.body?.transcript?.ranges ?? []).flatMap((range) => range.turns ?? []),
  ...(detail.body?.transcript?.activeTurns ?? []),
];
assert(transcriptTurns.length >= 5, "The background-task transcript fixture is incomplete");
assert(
  transcriptTurns.some((turn) => turn.blocks?.some((block) => block.type === "tool")),
  "Persisted tool events are missing",
);

const ticket = await jsonRequest(
  `/conversations/${seedWorkstreamId}/substreams/0/socket`,
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
      text: "Investigate ENG-142 and summarize the evidence before proposing a fix.",
      clientMessageId: "seed-eng-1",
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
  firstSocket.commandResult?.turn?.turnId === "00000000-0000-7000-8000-000000000032",
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
  sidebarFixtures: "ok",
  messageIdempotency: "ok",
  firstSocket: "snapshot",
  socketTransport: SOCKET_TICKET_SUBPROTOCOL,
  replaySocket: "rejected 401",
}));
