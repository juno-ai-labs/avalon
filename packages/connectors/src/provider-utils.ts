import { ConnectorError } from "./types";

const DEFAULT_RESPONSE_BYTES = 1_000_000;

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
    throw new ConnectorError(response.status === 401 || response.status === 403 ? "unauthorized" : "provider_error", message, {
      status: response.status,
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
