import { z } from "zod";
import { isUnknownSocketEvent } from "@rally/contracts";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { logError } from "../observability/logger";
import { workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceTranscriptionAdmitResultSchema,
  WorkspaceTranscriptionRenewResultSchema,
} from "../durable-objects/workspace-transcription-protocol";
import {
  MAX_CONCURRENT_USER_TRANSCRIPTION_SESSIONS,
  MAX_CONCURRENT_WORKSPACE_TRANSCRIPTION_SESSIONS,
  TRANSCRIPTION_SESSION_LEASE_SECONDS,
} from "../durable-objects/workspace-transcription-storage";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { asWorkspaceId } from "@rally/contracts";
import {
  isAllowedSocketOrigin,
  issueTranscriptionSocketTicket,
  socketTicketFromRequest,
  type TranscriptionSocketClaims,
  verifyTranscriptionSocketTicket,
  withNegotiatedSubprotocol,
} from "./socket-service";

import {
  TRANSCRIPTION_MAX_FRAME_CHARACTERS as MAX_CLIENT_FRAME_CHARACTERS,
} from "@rally/contracts/realtime-transcription";
import { runtimeDeferral } from "../lib/defer";
import { emitInferenceUsage } from "./usage-metering";
const SESSION_LEASE_REFRESH_MS = 60 * 1_000;
const RELEASE_RETRY_DELAYS_MS = [0, 50, 200] as const;

const transcriptionClientEventTypes = z.enum([
  "input_audio_buffer.append", "input_audio_buffer.commit", "input_audio_buffer.clear",
]);

type AllowedClientEvent =
  | { type: "input_audio_buffer.append"; audio: string }
  | { type: "input_audio_buffer.commit" }
  | { type: "input_audio_buffer.clear" };

function configuredAzureRealtime(env: Env): {
  endpoint: string;
  apiKey: string;
  deployment: string;
} {
  const endpoint = env.AZURE_OPENAI_ENDPOINT?.trim();
  const apiKey = env.AZURE_OPENAI_API_KEY?.trim();
  const deployment = env.AZURE_OPENAI_REALTIME_DEPLOYMENT?.trim();
  if (!endpoint || !apiKey || !deployment) {
    throw new ApiError(
      503,
      "dictation_not_configured",
      "Dictation is not configured for this Rally region",
    );
  }
  return { endpoint, apiKey, deployment };
}

export function azureRealtimeWebSocketUrl(
  env: Pick<Env, "AZURE_OPENAI_ENDPOINT">,
): string {
  const endpoint = env.AZURE_OPENAI_ENDPOINT?.trim();
  if (!endpoint) {
    throw new ApiError(503, "dictation_not_configured", "Dictation is not configured for this Rally region");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ApiError(503, "dictation_not_configured", "The Azure OpenAI endpoint is invalid");
  }
  if (url.protocol !== "https:") {
    throw new ApiError(503, "dictation_not_configured", "The Azure OpenAI endpoint must use HTTPS");
  }
  url.pathname = "/openai/v1/realtime";
  url.search = new URLSearchParams({ intent: "transcription" }).toString();
  url.hash = "";
  return url.toString();
}

export function transcriptionSessionUpdate(deployment: string): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          transcription: { model: deployment, delay: "minimal" },
          turn_detection: null,
        },
      },
    },
  };
}

export function parseTranscriptionClientEvent(raw: unknown): AllowedClientEvent | null {
  if (typeof raw !== "string" || raw.length > MAX_CLIENT_FRAME_CHARACTERS) return null;
  try {
    const event: unknown = JSON.parse(raw);
    if (!event || typeof event !== "object") return null;
    const candidate = event as Record<string, unknown>;
    if (candidate.type === "input_audio_buffer.append") {
      if (
        typeof candidate.audio !== "string" || candidate.audio.length === 0 ||
        base64DecodedByteLength(candidate.audio) === null
      ) return null;
      return { type: candidate.type, audio: candidate.audio };
    }
    if (candidate.type === "input_audio_buffer.commit" || candidate.type === "input_audio_buffer.clear") {
      return { type: candidate.type };
    }
    return null;
  } catch {
    return null;
  }
}

export function base64DecodedByteLength(value: string): number | null {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function sendableCloseCode(code: number, fallback = 1011): number {
  if (code === 1000) return code;
  if (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) return code;
  if (code >= 3_000 && code <= 4_999) return code;
  return fallback;
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
  const safeCode = sendableCloseCode(code);
  try {
    socket.close(safeCode, reason.slice(0, 123));
  } catch {
    try {
      socket.close(1011, "Realtime connection closed");
    } catch {
      // The peer may already have closed between the readyState check and close.
    }
  }
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try { socket.send(JSON.stringify(payload)); } catch { /* The peer closed before the send. */ }
}

function stringMessage(data: string | ArrayBuffer | Blob): string | null {
  return typeof data === "string" ? data : null;
}

/** The WorkspaceDO that owns this workspace's dictation admission state. */
function transcriptionWorkspace(env: Env, workspaceId: string) {
  return durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    asWorkspaceId(workspaceId),
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
}

async function reserveTranscriptionSession(
  env: Env,
  claims: TranscriptionSocketClaims,
): Promise<string> {
  // Admission state is owned by this workspace's WorkspaceDO, and admission is
  // one question to it. The expiry sweep, the one-time ticket consumption and
  // the cap-checked insert are a single critical section inside the object, so
  // two simultaneous upgrades cannot interleave through the middle of it. As
  // separate statements through the runtime facade they were three round trips
  // and three critical sections, which read as one and was not.
  const sessionId = crypto.randomUUID();
  const workspace = await transcriptionWorkspace(env, claims.workspaceId);
  const result = WorkspaceTranscriptionAdmitResultSchema.parse(
    await workspace.admitTranscriptionSession({
      workspaceId: claims.workspaceId,
      userId: claims.userId,
      ticketId: claims.ticketId,
      ticketExpiresAtSeconds: claims.expiresAt,
      sessionId,
      nowSeconds: Math.floor(Date.now() / 1_000),
    }),
  );
  if (result.outcome === "ticket_replayed") {
    throw new ApiError(401, "socket_ticket_replayed", "The realtime ticket has already been used");
  }
  if (result.outcome === "concurrency_limit") {
    throw new ApiError(429, "dictation_concurrency_limit", "Too many dictation sessions are already active");
  }
  return sessionId;
}

async function releaseTranscriptionSession(
  env: Env,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const workspace = await transcriptionWorkspace(env, workspaceId);
  await workspace.releaseTranscriptionSession({ workspaceId, sessionId });
}

async function renewTranscriptionSession(
  env: Env,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const workspace = await transcriptionWorkspace(env, workspaceId);
  // Parsed and discarded: the renewal reports whether there was a lease left to
  // extend, and there is nothing useful to do with a `false` here. The socket
  // that owns the session is the thing that ends, and it ends on its own close
  // rather than on a lease it stopped holding. The parse still runs, so a
  // response that stopped matching the contract fails here rather than later.
  WorkspaceTranscriptionRenewResultSchema.parse(await workspace.renewTranscriptionSession({
    workspaceId,
    sessionId,
    nowSeconds: Math.floor(Date.now() / 1_000),
  }));
}

export class RealtimeTranscriptionService {
  constructor(
    private readonly env: Env,
    private readonly defer: (promise: Promise<void>) => void = (promise) => { void promise; },
  ) {}

  async ticket(auth: AuthContext): Promise<{ url: string; ticket: string }> {
    configuredAzureRealtime(this.env);
    const ticket = await issueTranscriptionSocketTicket(this.env, auth);
    const url = new URL(this.env.PUBLIC_API_BASE_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/socket/transcription";
    url.search = "";
    return { url: url.toString(), ticket };
  }

  async upgrade(queryTicket: string | undefined, request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new ApiError(426, "websocket_upgrade_required", "A WebSocket upgrade is required");
    }
    if (!isAllowedSocketOrigin(this.env, request.headers.get("origin"))) {
      throw new ApiError(403, "socket_origin_forbidden", "The realtime origin is not allowed");
    }
    const claims = await verifyTranscriptionSocketTicket(
      this.env,
      socketTicketFromRequest(request, queryTicket),
    );
    if (claims.region !== this.env.AVALON_REGION) {
      throw new ApiError(403, "socket_ticket_scope_mismatch", "The realtime ticket belongs to another region");
    }

    const sessionId = await reserveTranscriptionSession(this.env, claims);
    // The realtime transcription stream reports no usage or price, so a
    // dictation session is metered as unpriced until a rate card exists.
    emitInferenceUsage(this.env, runtimeDeferral, {
      eventId: `stt:${sessionId}`,
      workspaceId: claims.workspaceId,
      activity: "dictation",
      costCents: undefined,
      model: null,
      refs: { userId: claims.userId },
    });
    let released = false;
    let releaseInFlight: Promise<void> | undefined;
    const release = (): Promise<void> => {
      if (released) return Promise.resolve();
      if (releaseInFlight) return releaseInFlight;
      releaseInFlight = releaseTranscriptionSession(this.env, claims.workspaceId, sessionId)
        .then(() => { released = true; })
        .finally(() => { releaseInFlight = undefined; });
      return releaseInFlight;
    };
    const releaseAndReport = async (): Promise<void> => {
      let lastError: unknown;
      for (const delayMs of RELEASE_RETRY_DELAYS_MS) {
        if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        try {
          await release();
          return;
        } catch (error) {
          lastError = error;
        }
      }
      logError(this.env, "realtime_transcription_session_release_failed", {
        session_id: sessionId,
        reason: lastError instanceof Error ? lastError.message : String(lastError),
      });
    };
    // The lease belongs to the open socket, not to the frames on it. The
    // desktop opens this socket as soon as its ticket lands, which can be
    // while the microphone permission prompt is still up, and a paused
    // recording sends nothing for as long as it is paused; either can outlast
    // the two-minute lease with no frame to renew it, after which the next
    // admission's sweep would delete a session that is still live. So the
    // renewal runs on a timer for as long as the client socket is open, and
    // stops on every path that releases the session.
    let leaseTimer: ReturnType<typeof setInterval> | undefined;
    const stopLeaseRenewal = (): void => {
      if (leaseTimer !== undefined) clearInterval(leaseTimer);
      leaseTimer = undefined;
    };
    const deferRelease = (): void => {
      stopLeaseRenewal();
      const promise = releaseAndReport();
      try {
        this.defer(promise);
      } catch {
        void promise;
      }
    };

    const azure = configuredAzureRealtime(this.env);
    try {
      const upstreamResponse = await fetch(azureRealtimeWebSocketUrl(this.env), {
        headers: { "api-key": azure.apiKey, Upgrade: "websocket" },
      });
      const upstream = upstreamResponse.webSocket;
      if (!upstream) {
        throw new ApiError(502, "azure_realtime_unavailable", "Azure OpenAI did not accept the realtime connection");
      }

      const pair = Object.values(new WebSocketPair());
      const client = pair[0];
      const server = pair[1];
      if (!client || !server) {
        closeSocket(upstream, 1011, "Rally realtime is unavailable");
        throw new ApiError(503, "websocket_unavailable", "Rally realtime is unavailable");
      }

      upstream.accept({ allowHalfOpen: true });
      server.accept({ allowHalfOpen: true });
      leaseTimer = setInterval(() => {
        if (server.readyState !== WebSocket.OPEN) {
          stopLeaseRenewal();
          return;
        }
        const renewal = renewTranscriptionSession(this.env, claims.workspaceId, sessionId)
          .catch((error: unknown) => {
            logError(this.env, "realtime_transcription_session_renewal_failed", {
              session_id: sessionId,
              reason: error instanceof Error ? error.message : String(error),
            });
          });
        try { this.defer(renewal); } catch { void renewal; }
      }, SESSION_LEASE_REFRESH_MS);

      server.addEventListener("message", (event) => {
        const parsed = parseTranscriptionClientEvent(stringMessage(event.data));
        if (!parsed) {
          try {
            if (isUnknownSocketEvent(JSON.parse(stringMessage(event.data) ?? ""), transcriptionClientEventTypes)) return;
          } catch { /* Malformed JSON keeps the existing error response. */ }
          sendJson(server, {
            type: "error",
            error: { code: "invalid_event", message: "Only realtime audio-buffer events are accepted." },
          });
          return;
        }
        sendJson(upstream, parsed);
      });
      upstream.addEventListener("message", (event) => {
        if (server.readyState !== WebSocket.OPEN || typeof event.data !== "string") return;
        try { server.send(event.data); } catch { /* The desktop closed before the provider frame arrived. */ }
      });
      server.addEventListener("close", (event) => {
        closeSocket(upstream, event.code || 1000, event.reason || "Client closed");
        deferRelease();
      });
      upstream.addEventListener("close", (event) => {
        closeSocket(server, event.code || 1011, event.reason || "Azure closed");
        deferRelease();
      });
      server.addEventListener("error", () => {
        closeSocket(upstream, 1011, "Client connection failed");
        deferRelease();
      });
      upstream.addEventListener("error", () => {
        closeSocket(server, 1011, "Azure realtime connection failed");
        deferRelease();
      });

      try {
        upstream.send(JSON.stringify(transcriptionSessionUpdate(azure.deployment)));
      } catch {
        closeSocket(server, 1011, "Azure realtime setup failed");
        closeSocket(upstream, 1011, "Azure realtime setup failed");
        throw new ApiError(502, "azure_realtime_unavailable", "Azure OpenAI rejected the realtime setup");
      }
      return withNegotiatedSubprotocol(request, new Response(null, { status: 101, webSocket: client }));
    } catch (error) {
      stopLeaseRenewal();
      await releaseAndReport();
      throw error;
    }
  }
}

export const __realtimeTranscriptionTesting = {
  base64DecodedByteLength,
  limits: {
    maxConcurrentUserSessions: MAX_CONCURRENT_USER_TRANSCRIPTION_SESSIONS,
    maxConcurrentWorkspaceSessions: MAX_CONCURRENT_WORKSPACE_TRANSCRIPTION_SESSIONS,
    sessionLeaseRefreshMs: SESSION_LEASE_REFRESH_MS,
    sessionLeaseSeconds: TRANSCRIPTION_SESSION_LEASE_SECONDS,
  },
  releaseTranscriptionSession,
  renewTranscriptionSession,
  reserveTranscriptionSession,
  sendableCloseCode,
};
