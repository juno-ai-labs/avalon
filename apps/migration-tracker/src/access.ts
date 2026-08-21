/**
 * Who is allowed to read the tracker.
 *
 * Cloudflare Access — the identity-aware proxy — stands in front of the
 * hostname. It supports Google as a login method and its policies take an
 * `email_domain` rule, which is the whole of what this site needs: Avalon's
 * Google Workspace domain, and nobody else. That is why the tracker does not
 * reuse Avalon's own Google OAuth: reusing it would mean minting sessions for
 * an operator tool out of the product's user identity system, and any account
 * that can sign in to Avalon would be one authorization bug away from the
 * fleet's schema state. Access keeps the operator boundary outside the product
 * entirely, and an unauthenticated request never reaches the Worker at all.
 *
 * The Worker still verifies the assertion itself. Access sets
 * `Cf-Access-Jwt-Assertion` on every request it forwards, and verifying it here
 * is what makes the protection survive the two ways edge enforcement can be
 * lost: a Worker route that outlives its Access application, and any path that
 * reaches the script without traversing the hostname. Trusting the header's
 * presence would be no protection at all — anyone can set a header — so the
 * signature, the issuer, the audience, and the email domain are all checked.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export interface AccessPrincipal {
  email: string;
  /** Access's stable per-user identifier, useful in a log line. */
  subject: string;
  /** The Access application the assertion was minted for. */
  audience: string;
}

export interface AccessConfiguration {
  /** The Zero Trust team domain, e.g. `rally.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access application's AUD tag. */
  applicationAudience: string;
  /** Lower-cased email domains admitted after the signature checks out. */
  allowedEmailDomains: string[];
}

export type AccessFailure =
  | "access_not_configured"
  | "access_assertion_missing"
  | "access_assertion_invalid"
  | "access_email_missing"
  | "access_email_domain_forbidden";

export type AccessResult =
  | { ok: true; principal: AccessPrincipal }
  | { ok: false; reason: AccessFailure };

export interface AccessEnvironment {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_APPLICATION_AUD?: string;
  ACCESS_ALLOWED_EMAIL_DOMAINS?: string;
}

/**
 * Read the Access configuration, or return null when it is incomplete.
 *
 * Null means the request is refused. A monitoring site that quietly serves
 * itself unauthenticated because a variable was not set is a worse outcome than
 * one that is unreachable until it is configured, and the failure is loud in
 * both the response and the log.
 */
export function readAccessConfiguration(env: AccessEnvironment): AccessConfiguration | null {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim().toLowerCase();
  const applicationAudience = env.ACCESS_APPLICATION_AUD?.trim();
  const allowedEmailDomains = (env.ACCESS_ALLOWED_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);

  if (!teamDomain || !applicationAudience || allowedEmailDomains.length === 0) return null;
  // A team domain is a hostname; anything with a scheme or a path in it is a
  // misconfiguration that would otherwise be assembled into a JWKS URL.
  if (!/^[a-z0-9][a-z0-9.-]*\.cloudflareaccess\.com$/u.test(teamDomain)) return null;
  return { teamDomain, applicationAudience, allowedEmailDomains };
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

  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (email.length === 0) return { ok: false, reason: "access_email_missing" };

  // Split on the last `@`: a local part may legally contain one, and taking the
  // first would let `attacker@evil.example@` masquerade as an allowed domain.
  const separator = email.lastIndexOf("@");
  const domain = separator === -1 ? "" : email.slice(separator + 1);
  if (!configuration.allowedEmailDomains.includes(domain)) {
    return { ok: false, reason: "access_email_domain_forbidden" };
  }

  return {
    ok: true,
    principal: {
      email,
      subject: typeof payload.sub === "string" ? payload.sub : "unknown",
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
      return "This site is not configured for Cloudflare Access yet, so it refuses every request.";
    case "access_assertion_missing":
      return "No Cloudflare Access assertion was presented. Reach this site through its Access application.";
    case "access_assertion_invalid":
      return "The Cloudflare Access assertion did not verify against this application.";
    case "access_email_missing":
      return "The Cloudflare Access assertion carries no email address.";
    case "access_email_domain_forbidden":
      return "That account's email domain is not permitted here.";
  }
}
