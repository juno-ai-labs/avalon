import WebSocket from "ws";

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

async function openSocket(url, { expectOpen }) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin: "app://avalon" });
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Realtime check timed out (${expectOpen ? "open" : "replay"})`));
    }, 5_000);

    const finish = (result) => {
      clearTimeout(timeout);
      resolve(result);
    };

    socket.addEventListener("message", (event) => {
      if (!expectOpen) return;
      try {
        const payload = JSON.parse(String(event.data));
        if (payload.type === "snapshot") {
          socket.close(1000, "Smoke check complete");
          finish({ opened: true, snapshot: true });
        }
      } catch (error) {
        clearTimeout(timeout);
        socket.close();
        reject(error);
      }
    });
    socket.addEventListener("open", () => {
      if (!expectOpen) {
        clearTimeout(timeout);
        socket.close();
        reject(new Error("A consumed realtime ticket was accepted"));
        return;
      }
      socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
    });
    socket.addEventListener("error", () => {
      if (expectOpen) {
        clearTimeout(timeout);
        reject(new Error("Realtime connection failed before the snapshot"));
      } else {
        finish({ opened: false, snapshot: false });
      }
    });
    socket.addEventListener("close", () => {
      if (!expectOpen) finish({ opened: false, snapshot: false });
    });
  });
}

const health = await jsonRequest("/health");
assert(health.response.ok && health.body?.ok === true, "Local Worker health check failed");

const session = await jsonRequest("/auth/dev/session", { method: "POST" });
assert(session.response.status === 201 && session.body?.accessToken, "Development sign-in failed");
const authHeaders = {
  authorization: `Bearer ${session.body.accessToken}`,
  "content-type": "application/json",
};

const protectedPaths = ["/workspace", "/workstreams", "/automations", "/connections"];
for (const path of protectedPaths) {
  const result = await jsonRequest(path, { headers: authHeaders });
  assert(result.response.ok, `${path} returned ${result.response.status}`);
}

if (otherBaseUrl) {
  const crossRegion = await jsonRequest("/workspace", { headers: authHeaders }, otherBaseUrl);
  assert(crossRegion.response.status === 409, "A session was accepted by the other regional API");
  assert(crossRegion.body?.error?.code === "region_mismatch", "Cross-region access did not report a region mismatch");
}

const workspace = await jsonRequest("/workspace", { headers: authHeaders });
const expectedRegion = health.body?.region;
assert(workspace.body?.region === expectedRegion, "The organization was not bound to the API's region");

const wrongRegion = expectedRegion === "global" ? "eu" : "global";
const wrongRegionStart = await jsonRequest("/auth/google/start", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    region: wrongRegion,
    workspaceName: "Avalon Smoke",
    desktopAttemptId: "a".repeat(43),
    desktopCodeChallenge: "c".repeat(43),
  }),
});
assert(wrongRegionStart.response.status === 409, "Google sign-in accepted the wrong regional selector");

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

const detail = await jsonRequest(`/workstreams/${seedWorkstreamId}`, { headers: authHeaders });
assert(detail.response.ok, "Seeded work-stream detail is unavailable; run pnpm db:seed first");
assert(detail.body?.resources?.length > 0, "The right-rail resource fixture is missing");
assert(detail.body?.connections?.length > 0, "The right-rail connection fixture is missing");

const messages = await jsonRequest(`/workstreams/${seedWorkstreamId}/messages?limit=200`, { headers: authHeaders });
assert(messages.response.ok && messages.body?.items?.length >= 5, "The background-task transcript fixture is incomplete");
assert(messages.body.items.some((message) => message.messageType === "tool"), "Persisted tool events are missing");

const replayedMessage = await jsonRequest(`/workstreams/${seedWorkstreamId}/messages`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    text: "Investigate ENG-142 and summarize the evidence before proposing a fix.",
    clientMessageId: "seed-eng-1",
    mentions: [],
    confirmedParticipantUserIds: [],
  }),
});
assert(replayedMessage.response.status === 201, "Message idempotency replay failed");
assert(replayedMessage.body?.message?.id === "00000000-0000-7000-8000-000000000032", "Message replay created a duplicate");
assert(replayedMessage.body?.agentInvoked === false, "Message replay launched duplicate agent work");

const unsafeMonitor = await jsonRequest("/connections/web-monitor", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ url: "http://127.0.0.1/private", intervalSeconds: 300, phrase: null, scope: "personal" }),
});
assert(unsafeMonitor.response.status === 422, "Unsafe web-monitor URL was not rejected");

const ticket = await jsonRequest(`/workstreams/${seedWorkstreamId}/socket`, { headers: authHeaders });
assert(ticket.response.ok && ticket.body?.url, "Realtime ticket creation failed");
const firstSocket = await openSocket(ticket.body.url, { expectOpen: true });
assert(firstSocket.snapshot, "Realtime connection did not provide a snapshot");
const replaySocket = await openSocket(ticket.body.url, { expectOpen: false });
assert(!replaySocket.opened, "Realtime ticket replay was accepted");

console.log(JSON.stringify({
  health: "ok",
  protectedEndpoints: protectedPaths.length,
  organizationRegion: expectedRegion,
  invitationLifecycle: "ok",
  crossRegionSession: otherBaseUrl ? "rejected" : "not checked",
  sidebarFixtures: "ok",
  messageIdempotency: "ok",
  unsafeMonitor: unsafeMonitor.response.status,
  firstSocket: "snapshot",
  replaySocket: "rejected",
}));
