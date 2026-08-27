import {
  ConnectorError,
  connectorCredentialRotation,
  type ConnectorConnectionContext,
} from "./types";
import {
  connectorObservationErrorCode,
  connectorObservationFailureLevel,
  observeConnectorConnection,
} from "./observability";

const DEFAULT_RESPONSE_BYTES = 1_000_000;

/**
 * Runs a provider call and, if the provider rejects the credential it carried,
 * refreshes that credential once and repeats the call.
 *
 * The host refreshes an expiring credential before an adapter is ever reached,
 * so this is not that guard duplicated. It covers what the host cannot see: a
 * token revoked between the two calls, a provider that expires one early or
 * disagrees about the clock, a long-running call whose credential ages out
 * mid-flight. Freshness at the door makes the rejection rare; recovering from
 * it is what keeps a connector from surfacing a transient one as a revoked
 * grant.
 *
 * Refreshed credentials are written back onto `connection.credentials`, which
 * is what the host's credential door persists when the operation returns. When
 * the host supplied a serialized `rotateCredentials`, that is used in
 * preference to the adapter's own refresh: a rotating refresh token is
 * single-use, and two calls refused at the same moment must not each redeem it.
 *
 * A second rejection is a real one and is raised: it is no longer plausible
 * that the credential was merely stale.
 */
export async function withProviderReauthorization<T>(
  connection: ConnectorConnectionContext,
  input: {
    /** Mints replacement credentials, usually the adapter's own `refreshCredentials`. */
    refresh: (
      connection: ConnectorConnectionContext,
      signal: AbortSignal,
    ) => Promise<Record<string, unknown>>;
    /** Whether this failure is the provider refusing the credential. */
    isRejection: (error: unknown) => boolean;
    /** Whether the connection holds what a refresh needs. */
    canRefresh?: (connection: ConnectorConnectionContext) => boolean;
    signal: AbortSignal;
  },
  call: () => Promise<T>,
): Promise<T> {
  // A copy, not the live reference: an adapter that mutates credentials in
  // place before failing would otherwise leave this pointing at the mutated
  // object, and the host's rotation would read that difference as a sibling
  // having already rotated and skip the refresh entirely.
  const refused = { ...connection.credentials };
  try {
    return await call();
  } catch (error) {
    if (!input.isRejection(error)) throw error;
    observeConnectorConnection(connection, "warn", "connector_credential_reauthorization_started", {
      reason: "provider_credential_rejected",
    });
    if (input.canRefresh && !input.canRefresh(connection)) {
      observeConnectorConnection(connection, "warn", "connector_credential_reauthorization_finished", {
        outcome: "not_refreshable",
        code: connectorObservationErrorCode(error),
      });
      throw error;
    }
    if (isAbortError(error)) {
      observeConnectorConnection(connection, "warn", "connector_credential_reauthorization_finished", {
        outcome: "aborted",
        code: "request_aborted",
      });
      throw error;
    }
    if (input.signal.aborted) {
      observeConnectorConnection(connection, "warn", "connector_credential_reauthorization_finished", {
        outcome: "aborted",
        code: "request_aborted",
      });
      input.signal.throwIfAborted();
    }
    const rotate = connectorCredentialRotation(connection);
    const rotationSource = rotate ? "host_serialized" : "adapter";
    observeConnectorConnection(connection, "debug", "connector_credential_refresh_started", {
      reason: "provider_credential_rejected",
      rotation_source: rotationSource,
    });
    try {
      connection.credentials = rotate
        ? await rotate(refused, input.signal)
        : await input.refresh(connection, input.signal);
      observeConnectorConnection(connection, "info", "connector_credential_refresh_finished", {
        outcome: "succeeded",
        rotation_source: rotationSource,
      });
    } catch (refreshError) {
      const level = connectorObservationFailureLevel(refreshError);
      const fields = {
        outcome: "failed",
        code: connectorObservationErrorCode(refreshError),
        rotation_source: rotationSource,
      };
      observeConnectorConnection(connection, level, "connector_credential_refresh_finished", fields);
      observeConnectorConnection(connection, level, "connector_credential_reauthorization_finished", fields);
      throw refreshError;
    }
    observeConnectorConnection(connection, "debug", "connector_provider_retry_started", {
      reason: "credential_refreshed",
      rotation_source: rotationSource,
    });
    try {
      const result = await call();
      observeConnectorConnection(connection, "info", "connector_credential_reauthorization_finished", {
        outcome: "recovered",
        rotation_source: rotationSource,
      });
      return result;
    } catch (retryError) {
      observeConnectorConnection(
        connection,
        connectorObservationFailureLevel(retryError),
        "connector_credential_reauthorization_finished",
        {
          outcome: "failed",
          code: connectorObservationErrorCode(retryError),
          rotation_source: rotationSource,
        },
      );
      throw retryError;
    }
  }
}

/**
 * Replaces a credential the adapter itself judged too close to expiry.
 *
 * The host refreshes before an adapter is reached, so this fires only when a
 * long-running operation crosses the expiry boundary mid-flight — but when it
 * does, two concurrent operations would each redeem the same rotating refresh
 * token if they refreshed privately. It is the same race
 * `withProviderReauthorization` closes on the rejection route, and it is closed
 * the same way: through the host's serialized rotation when one is registered,
 * falling back to the adapter's own refresh when none is (a diagnostic path, or
 * a caller outside the credential door).
 */
export async function refreshExpiringCredentials(
  connection: ConnectorConnectionContext,
  refresh: (
    connection: ConnectorConnectionContext,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const rotate = connectorCredentialRotation(connection);
  const rotationSource = rotate ? "host_serialized" : "adapter";
  observeConnectorConnection(connection, "debug", "connector_credential_refresh_started", {
    reason: "credential_expiring",
    rotation_source: rotationSource,
  });
  try {
    const credentials = await (rotate
      ? rotate({ ...connection.credentials }, signal)
      : refresh(connection, signal));
    observeConnectorConnection(connection, "info", "connector_credential_refresh_finished", {
      outcome: "succeeded",
      reason: "credential_expiring",
      rotation_source: rotationSource,
    });
    return credentials;
  } catch (error) {
    observeConnectorConnection(
      connection,
      connectorObservationFailureLevel(error),
      "connector_credential_refresh_finished",
      {
        outcome: "failed",
        reason: "credential_expiring",
        code: connectorObservationErrorCode(error),
        rotation_source: rotationSource,
      },
    );
    throw error;
  }
}

/**
 * Whether an error is the provider refusing the credential that was presented.
 *
 * `unauthorized` alone is far too broad to answer this: adapters also raise it
 * for policy and configuration failures that never reached the provider — a
 * tool invoked without its invocation token, an event from another workspace, a
 * missing token — and rotating a refresh token over one of those spends a
 * single-use grant to retry something that will fail identically. The provider
 * vocabulary that means "this credential is stale" is provider-specific, so
 * each adapter states its own; only errors carrying provider response details
 * are eligible in the first place.
 */
export function isProviderCredentialRejection(
  error: unknown,
  matches: (details: Record<string, unknown>) => boolean,
): boolean {
  return error instanceof ConnectorError
    && error.code === "unauthorized"
    && isRecord(error.details)
    && matches(error.details);
}

/**
 * The OAuth error codes that mean the member's grant itself is gone, so the
 * only recovery is reconnecting.
 *
 * Deliberately excludes `invalid_client`, `unauthorized_client`,
 * `invalid_request`, and `invalid_scope`: every one of those is Avalon's
 * configuration or Avalon's request being wrong, and none of them is fixed by a
 * member reauthorizing an account that still works.
 */
const REVOKED_GRANT_ERRORS = new Set(["invalid_grant", "expired_token", "invalid_token"]);

/**
 * Codes that say Avalon's configuration or request was wrong. None is fixed by
 * a member reauthorizing an account that still works, so none marks a
 * connection for reconnection.
 */
const CONFIGURATION_ERRORS = new Set([
  "invalid_client",
  "unauthorized_client",
  "invalid_request",
  "invalid_scope",
  "unsupported_grant_type",
]);

/**
 * Whether an OAuth error code a token endpoint named means the grant is dead.
 *
 * For the callers that hold the code but no HTTP status — a provider that
 * reports a token failure as `200 {"error": "..."}`, as GitHub does — so they
 * do not have to treat every named error as a revoked grant and nag members to
 * reconnect accounts that work. An unfamiliar code still counts as revoked: the
 * two ways to be wrong are not symmetric, and leaving a dead connection
 * reporting healthy strands it silently.
 */
export function isRevokedGrantCode(code: string): boolean {
  return !CONFIGURATION_ERRORS.has(code);
}

/**
 * Whether a token-endpoint failure means the stored grant is dead.
 *
 * Classifying by status alone marks a connection `needs_reconnect` for any 400
 * or 403, which is how a malformed request or a proxy's rate limit ends up
 * demanding that a member reauthorize a healthy account. When the provider sent
 * an error code, that code decides. With no code at all the original status
 * test stands — 400, 401, and 403 — because an unclassifiable rejection that
 * leaves a dead connection reporting healthy strands it silently, and that is
 * the worse of the two ways to be wrong here.
 */
export function isRevokedGrantError(error: unknown): error is ConnectorError {
  if (!(error instanceof ConnectorError) || !isRecord(error.details)) return false;
  const providerError = error.details.providerError;
  if (typeof providerError === "string") {
    if (REVOKED_GRANT_ERRORS.has(providerError)) return true;
    // Only a code we recognize as Avalon's own fault answers "no". An
    // unrecognized code is not evidence of anything, and treating it as a
    // denial of the question inverts the safe default below — a provider
    // spelling a dead grant in a word this list has not learned would leave
    // the connection healthy, failing every call, prompting nobody.
    if (CONFIGURATION_ERRORS.has(providerError)) return false;
  }
  // No code to read. Guessing wrong in this direction nags a member to reconnect
  // an account that works; guessing wrong in the other leaves a dead connection
  // reporting healthy while every call fails and nothing ever prompts them. The
  // silent one is worse, so an unclassifiable rejection keeps the original
  // status test.
  return [400, 401, 403].includes(Number(error.details.status));
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ProviderJsonResponse {
  data: Record<string, unknown>;
  headers: Headers;
  status: number;
}

export async function providerJson(
  fetcher: FetchLike,
  url: string | URL,
  init: RequestInit = {},
  maxBytes = DEFAULT_RESPONSE_BYTES,
): Promise<Record<string, unknown>> {
  return (await providerJsonResponse(fetcher, url, init, maxBytes)).data;
}

export async function providerJsonResponse(
  fetcher: FetchLike,
  url: string | URL,
  init: RequestInit = {},
  maxBytes = DEFAULT_RESPONSE_BYTES,
): Promise<ProviderJsonResponse> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ConnectorError("provider_error", "The provider request could not be completed", error);
  }
  const bytes = await readResponseBytes(response, maxBytes);
  const text = new TextDecoder().decode(bytes);
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch (error) {
      throw new ConnectorError("provider_error", "The provider returned malformed JSON", error);
    }
  }
  if (!response.ok) {
    const message = providerErrorMessage(payload) ?? `The provider returned HTTP ${response.status}`;
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    // The provider's own short error code, when it sent one. A status alone
    // cannot separate "this grant is gone" from "this request was malformed" —
    // OAuth reports both as 400 — and telling a member to reconnect a working
    // account because of our own bad request is the worse of the two mistakes.
    const providerError = providerErrorCode(payload);
    throw new ConnectorError(response.status === 401 || response.status === 403 ? "unauthorized" : "provider_error", message, {
      status: response.status,
      ...(providerError ? { providerError } : {}),
      ...(retryAfterMs != null ? { retryAfterMs } : {}),
    });
  }
  if (!isRecord(payload)) throw new ConnectorError("provider_error", "The provider returned an invalid response");
  return {
    data: payload,
    headers: new Headers(response.headers),
    status: response.status,
  };
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/u.test(value.trim())) return Math.max(0, Math.ceil(Number(value) * 1_000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError("payload_too_large", "The provider response exceeded the configured size limit");
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new ConnectorError("payload_too_large", "The provider response exceeded the configured size limit");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ConnectorError("payload_too_large", "The provider response exceeded the configured size limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function jsonHeaders(token: string, extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return headers;
}

export async function verifyHmacSha256(
  secret: string,
  body: string,
  suppliedSignature: string | null,
  prefix = "",
): Promise<void> {
  if (!secret || !suppliedSignature) throw new ConnectorError("invalid_signature", "The webhook signature is missing");
  const normalized = prefix && suppliedSignature.startsWith(prefix)
    ? suppliedSignature.slice(prefix.length)
    : suppliedSignature;
  if (!/^[0-9a-f]{64}$/iu.test(normalized)) {
    throw new ConnectorError("invalid_signature", "The webhook signature is malformed");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const supplied = hexToBytes(normalized);
  if (!timingSafeEqual(expected, supplied)) {
    throw new ConnectorError("invalid_signature", "The webhook signature is invalid");
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return bytesToHex(digest);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === "string" ? record[key] : null;
}

export function numberValue(record: Record<string, unknown>, key: string): number | null {
  return typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : null;
}

export function booleanValue(record: Record<string, unknown>, key: string): boolean | null {
  return typeof record[key] === "boolean" ? record[key] : null;
}

export function recordValue(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return isRecord(record[key]) ? record[key] : null;
}

export function recordArray(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  return Array.isArray(record[key]) ? record[key].filter(isRecord) : [];
}

export function truncateText(value: string, maxChars = 50_000): { text: string; truncated: boolean; totalChars: number } {
  const totalChars = value.length;
  if (totalChars <= maxChars) return { text: value, truncated: false, totalChars };
  return { text: value.slice(0, maxChars), truncated: true, totalChars };
}

export function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The provider's own short error code, wherever it put it.
 *
 * OAuth says `error`, and Notion answers its token endpoint with an envelope
 * keyed `code`; some providers nest either inside an object. Reading only the
 * first would silently drop the classification for the rest and fall back to
 * judging by status, which is the thing the code exists to avoid.
 */
function providerErrorCode(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  for (const key of ["error", "code"]) {
    const value = payload[key];
    if (typeof value === "string" && value) return value;
    if (isRecord(value)) {
      for (const nested of ["code", "error", "type"]) {
        const inner = value[nested];
        if (typeof inner === "string" && inner) return inner;
      }
    }
  }
  return null;
}

function providerErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const key of ["error_description", "message", "error"]) {
    if (typeof value[key] === "string" && value[key]) return value[key];
    if (isRecord(value[key]) && typeof value[key].message === "string") return value[key].message;
  }
  return null;
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
