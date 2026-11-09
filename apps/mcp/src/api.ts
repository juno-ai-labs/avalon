import { isConfiguredRegion, regionConfiguration, type Region } from "@rally/contracts/regions";

import type { Env } from "./env";

/**
 * What this Worker reads from a bearer token without verifying it: its
 * audience, expiry and deployment. The regional API verifies the signature
 * and the session on every call; this read only lets the MCP endpoint answer
 * 401 itself, before any tool runs, for a token that is plainly not an MCP
 * client's or has expired, so the client refreshes or reconnects rather than
 * seeing every tool fail. `docs/rally-mcp.md#tokens`.
 */
export type TokenInspection =
  | { ok: true; token: string; region: Region }
  | { ok: false; reason: "missing" | "malformed" | "audience" | "expired" | "region" };

export const MCP_TOKEN_AUDIENCE = "rally-mcp";

export function inspectBearer(authorization: string | null, now = Date.now()): TokenInspection {
  if (!authorization?.startsWith("Bearer ")) return { ok: false, reason: "missing" };
  const token = authorization.slice(7).trim();
  const payload = token.split(".")[1];
  if (!payload) return { ok: false, reason: "malformed" };
  let claims: unknown;
  try {
    claims = JSON.parse(atob(payload.replace(/-/gu, "+").replace(/_/gu, "/")));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims !== "object" || claims === null) return { ok: false, reason: "malformed" };
  const { aud, exp, region } = claims as { aud?: unknown; exp?: unknown; region?: unknown };
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(MCP_TOKEN_AUDIENCE)) return { ok: false, reason: "audience" };
  if (typeof exp !== "number" || exp * 1_000 <= now) return { ok: false, reason: "expired" };
  if (typeof region !== "string" || !isConfiguredRegion(region)) return { ok: false, reason: "region" };
  return { ok: true, token, region };
}

/** The API Worker for a deployment, through its service binding; never a caller-chosen host. */
export function regionalApi(env: Env, region: Region): Fetcher | undefined {
  return env[`${regionConfiguration(region).bindingPrefix}_API`];
}

/** A refusal the Rally API answered, under its own code. */
export class RallyApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "RallyApiError";
  }
}

/**
 * The product API as the connected person: every call carries their MCP
 * token and reaches the same route the app calls, so the Organization's
 * roles and each Canvas's audience decide exactly as they do there.
 */
export class RallyApi {
  constructor(private readonly api: Fetcher, private readonly token: string, private readonly region: Region) {}

  async json<T = unknown>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    const response = await this.send(method, path, body);
    if (response.status === 204) return undefined as T;
    return await response.json<T>();
  }

  async send(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<Response> {
    const headers = new Headers({ authorization: `Bearer ${this.token}`, accept: "application/json" });
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await this.api.fetch(new Request(new URL(path, regionConfiguration(this.region).apiUrl), {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    if (response.ok) return response;
    const failure = await response.json<{ error?: { code?: unknown; message?: unknown } }>().catch(() => null);
    const code = typeof failure?.error?.code === "string" ? failure.error.code : `http_${response.status}`;
    const message = typeof failure?.error?.message === "string" ? failure.error.message : `Rally answered ${response.status}`;
    throw new RallyApiError(response.status, code, message);
  }
}
