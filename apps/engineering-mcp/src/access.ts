/** Cloudflare Access owns authorization policy. This module verifies JWT
 * provenance: signature, issuer, audience, and required principal claims. */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

const UNKNOWN_ACCESS_SUBJECT = "unknown";

export interface AccessPrincipal {
  /**
   * Informational identity for audit logs; never used to authorize tools.
   */
  email: string | null;
  /** Access's stable per-user identifier, useful in a log line. */
  subject: string;
  /** The Access application the assertion was minted for. */
  audience: string;
}

/** Stored results need an owner; audit-only principals may lack a subject. */
export function hasStableAccessSubject(principal: AccessPrincipal): boolean {
  return principal.subject.length > 0 && principal.subject !== UNKNOWN_ACCESS_SUBJECT;
}

export interface AccessConfiguration {
  /** The Zero Trust team domain, e.g. `rally.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access application's AUD tag. */
  applicationAudience: string;
}

export type AccessFailure =
  | "access_not_configured"
  | "access_assertion_missing"
  | "access_assertion_invalid";

export type AccessResult =
  | { ok: true; principal: AccessPrincipal }
  | { ok: false; reason: AccessFailure };

export interface AccessEnvironment {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_APPLICATION_AUD?: string;
}

/**
 * Read the Access configuration, or return null when it is incomplete.
 *
 * Null means the request is refused. An MCP endpoint that quietly serves
 * tools unauthenticated because a variable was not set is a worse outcome than
 * one that is unreachable until it is configured, and the failure is loud in
 * both the response and the log.
 */
export function readAccessConfiguration(env: AccessEnvironment): AccessConfiguration | null {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim().toLowerCase();
  const applicationAudience = env.ACCESS_APPLICATION_AUD?.trim();

  if (!teamDomain || !applicationAudience) return null;
  // A team domain is a hostname; anything with a scheme or a path in it is a
  // misconfiguration that would otherwise be assembled into a JWKS URL.
  if (!/^[a-z0-9][a-z0-9.-]*\.cloudflareaccess\.com$/u.test(teamDomain)) return null;
  return { teamDomain, applicationAudience };
}

const keySets = new Map<string, JWTVerifyGetKey>();

/** One remote key set per team domain, cached for the isolate's lifetime. */
function keySetFor(teamDomain: string): JWTVerifyGetKey {
  const existing = keySets.get(teamDomain);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
  keySets.set(teamDomain, created);
  return created;
}

export interface VerifyAccessOptions {
  /** Injected by the suite so verification can run against a local key. */
  keySet?: JWTVerifyGetKey;
}

export async function verifyAccessRequest(
  request: Request,
  configuration: AccessConfiguration | null,
  options: VerifyAccessOptions = {},
): Promise<AccessResult> {
  if (!configuration) return { ok: false, reason: "access_not_configured" };

  const assertion = request.headers.get("cf-access-jwt-assertion")
    ?? cookieValue(request.headers.get("cookie"), "CF_Authorization");
  if (!assertion) return { ok: false, reason: "access_assertion_missing" };

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(
      assertion,
      options.keySet ?? keySetFor(configuration.teamDomain),
      {
        issuer: `https://${configuration.teamDomain}`,
        audience: configuration.applicationAudience,
      },
    );
    payload = verified.payload;
  } catch {
    return { ok: false, reason: "access_assertion_invalid" };
  }

  // Read but never judged. A token with no email — a service token, say — is
  // still a token this application's policy admitted, so it is admitted here.
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";

  return {
    ok: true,
    principal: {
      email: email.length > 0 ? email : null,
      subject: typeof payload.sub === "string" ? payload.sub : UNKNOWN_ACCESS_SUBJECT,
      audience: configuration.applicationAudience,
    },
  };
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/** The operator-facing sentence for each refusal. */
export function accessFailureMessage(reason: AccessFailure): string {
  switch (reason) {
    case "access_not_configured":
      return "The engineering MCP is not configured for Cloudflare Access yet, so it refuses every request.";
    case "access_assertion_missing":
      return "No Cloudflare Access assertion was presented. Reach the engineering MCP through its Access application.";
    case "access_assertion_invalid":
      return "The Cloudflare Access assertion did not verify against this application.";
  }
}
