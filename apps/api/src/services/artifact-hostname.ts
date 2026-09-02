/**
 * Allocate and materialize one live artifact's public hostname stub.
 *
 * The dedicated platform D1 row is both collision authority and serving index.
 * It contains no product or user data, so the isolated serving Worker can read
 * it without receiving either region's product database.
 */
import {
  ArtifactHostnameStubSchema,
  type ArtifactHostnameStub,
} from "@rally/contracts";
import { nowIso } from "@rally/db";

import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { allocateWorkstreamEmailAddressCandidate } from "../lib/workstream-email-address";

/**
 * LIMIT UNSET — open, enforcing nothing. Awaiting a value from the team; see
 * docs/adding-security-defensive-and-other-limits.md.
 *
 * Bounds: D1 collision attempts while reserving one artifact hostname.
 * Without it: a corrupted or adversarially saturated route table can keep one
 *   authenticated publish/open request issuing paid D1 writes indefinitely.
 *   No upstream bound limits those attempts.
 * Direction: upper bound; the open value is +Infinity.
 * Trips: allocation fails with `artifact_hostname_exhausted`; no product or
 *   WorkspaceDO row points at an unreserved hostname.
 * Derive from: the acceptable D1 cost and request duration for one publish,
 *   weighed against the four-word vocabulary's collision probability.
 */
export const MAXIMUM_HOSTNAME_ALLOCATION_ATTEMPTS = Number.POSITIVE_INFINITY;

async function hostnameKey(env: Env): Promise<string> {
  return sha256(`artifact-hostname:${env.SESSION_SIGNING_KEY}`);
}

export async function artifactHostnameCandidate(
  env: Env,
  workspaceId: string,
  artifactId: string,
  attempt: number,
): Promise<ArtifactHostnameStub> {
  return ArtifactHostnameStubSchema.parse(await allocateWorkstreamEmailAddressCandidate({
    secretKey: await hostnameKey(env),
    workstreamId: `${env.AVALON_REGION}:${workspaceId}:artifact:${artifactId}`,
    attempt,
  }));
}

interface ArtifactHostnameInput {
  workspaceId: string;
  artifactId: string;
}

async function existingHostname(env: Env, input: ArtifactHostnameInput): Promise<ArtifactHostnameStub | null> {
  const row = await env.PLATFORM_DB.prepare(
    `SELECT hostname_stub FROM artifact_hostname_routes
      WHERE region = ? AND artifact_id = ?`,
  ).bind(env.AVALON_REGION, input.artifactId)
    .first<{ hostname_stub: string }>();
  return row ? ArtifactHostnameStubSchema.parse(row.hostname_stub) : null;
}

/** Reserve one region-wide hostname, idempotently, with collision advance. */
export async function ensureArtifactHostname(
  env: Env,
  input: ArtifactHostnameInput,
  maximumAttempts = MAXIMUM_HOSTNAME_ALLOCATION_ATTEMPTS,
): Promise<ArtifactHostnameStub> {
  const existing = await existingHostname(env, input);
  if (existing) return existing;

  const createdAt = nowIso();
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const candidate = await artifactHostnameCandidate(env, input.workspaceId, input.artifactId, attempt);
    await env.PLATFORM_DB.prepare(
      `INSERT INTO artifact_hostname_routes
       (hostname_stub, region, artifact_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(candidate, env.AVALON_REGION, input.artifactId, createdAt).run();
    const reserved = await existingHostname(env, input);
    if (reserved) return reserved;
  }
  throw new Error("artifact_hostname_exhausted");
}
