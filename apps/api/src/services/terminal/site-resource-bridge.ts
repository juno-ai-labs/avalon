import type { Region } from "@rally/contracts/regions";
/**
 * Turning a published directory into a **live artifact**: a resource Rally also
 * serves.
 *
 * The document path publishes bytes and stops. A site publishes a *version*:
 * every file goes into the region's payload bucket under a version-immutable
 * key, a manifest describing them becomes the resource's stored content, the
 * artifact is registered beside the resource authority, and the supervisor
 * object is pointed at the new version. Only then is the URL live.
 *
 * **The order is the contract.** Assets, then manifest, then public-hostname
 * reservation, then resource row, then the supervisor's pointer — each step
 * only depends on ones that already committed, so a failure anywhere leaves the
 * artifact serving its *previous* version rather than a version whose bytes a
 * viewer cannot read. The reverse order would put a pointer in front of assets
 * that might never land, and moving the resource before hostname reservation
 * would make an equal-content retry return the previous registry version.
 *
 * See `docs/live-web-artifacts.md`.
 */
import {
  ARTIFACT_MAX_ASSET_COUNT,
  ArtifactHostnameStubSchema,
  SITE_MANIFEST_MIME_TYPE,
  artifactAssetKey,
  artifactManifestKey,
  asArtifactId,
  type ArtifactManifest,
  type ArtifactMode,
  type ArtifactHostnameStub,
} from "@rally/contracts";
import { newId, nowIso } from "@rally/db";

import type { Env } from "../../env";
import { artifactHostDOName } from "../../durable-objects/names";
import { sha256Hex } from "../../lib/crypto";
import { durableObjectStubForArtifact, workspacePlacementAffinity } from "../../lib/durable-object-namespace";
import { ensureArtifactHostname } from "../artifact-hostname";
import { assetContentType } from "./site-publish";
import { prepareSocialPreview } from "./site-social-preview";
import { TerminalToolError } from "./tools";

export interface SitePublishFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface SitePublishInput {
  workspaceId: string;
  workstreamId: string;
  region: Region;
  /** The artifact this path already published as, or `null` for the first one. */
  artifactId: string | null;
  resourceId: string;
  version: number;
  mode: ArtifactMode;
  stateful: boolean;
  files: readonly SitePublishFile[];
  /** Human-readable fallback when the page did not author a title. */
  fallbackTitle: string;
  serverModuleSha256: string | null;
}

export interface SitePublishResult {
  artifactId: string;
  manifest: ArtifactManifest;
  manifestBytes: Uint8Array;
  manifestSha256: string;
  manifestRef: string;
}

/**
 * Write one version's bytes, and return the manifest that becomes the
 * resource's content.
 *
 * The server module is written to the bucket like every other file but is
 * **absent from `assets`**, which is what makes a viewer's request for
 * `/index.js` a 404: the serving Worker resolves requests against `assets` and
 * nothing else. No secret can be in the module — the sandbox guarantees that —
 * but serving a site's own source to its viewers is surface nobody asked for,
 * and the import tool is how the model reads it back.
 */
export async function writeArtifactVersion(
  env: Pick<Env, "PAYLOADS">,
  input: SitePublishInput,
): Promise<SitePublishResult> {
  const artifactId = input.artifactId ?? newId();
  const serverEntry = input.mode === "active" ? "index.js" : null;
  const preparedPreview = await prepareSocialPreview(input.files, input.fallbackTitle);
  const storedFiles = preparedPreview.generatedFile
    ? [...input.files, preparedPreview.generatedFile]
    : [...input.files];
  const assets = storedFiles
    .filter((file) => file.path !== serverEntry)
    .map((file) => ({
      path: file.path,
      contentType: assetContentType(file.path),
      sizeBytes: file.bytes.byteLength,
      sha256: file.sha256,
    }));
  if (assets.length > ARTIFACT_MAX_ASSET_COUNT) {
    throw new TerminalToolError(
      "resource_publish_failed",
      `This site has too many served files to add its generated social preview. Keep the directory below ${ARTIFACT_MAX_ASSET_COUNT} served files and publish it again.`,
      { field: "filePath", reason: "Remove at least one served file, then publish the directory again." },
    );
  }
  const manifest: ArtifactManifest = {
    version: 1,
    artifactId: asArtifactId(artifactId),
    artifactVersion: input.version,
    mode: input.mode,
    stateful: input.stateful,
    serverModuleSha256: input.serverModuleSha256,
    assets,
    socialPreview: preparedPreview.socialPreview,
    totalBytes: storedFiles.reduce((total, file) => total + file.bytes.byteLength, 0),
    publishedAt: nowIso(),
  };

  try {
    // Cloudflare permits six outgoing connections awaiting response headers per
    // top-level invocation, including R2; a seventh queues. This uses six whole
    // upload jobs as a conservative per-invocation worker budget, not as a
    // claim about the header-phase limit or an account-wide transfer cap.
    // Transcribed 2026-09-12:
    // https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections
    const simultaneousConnections = 6;
    const files = storedFiles.values();
    let uploadFailed = false;
    const uploads = Array.from({ length: Math.min(storedFiles.length, simultaneousConnections) }, async () => {
      for (const file of files) {
        // A failed version will never publish, so drain writes already begun
        // by sibling workers but do not start another asset after a failure.
        if (uploadFailed) return;
        try {
          await env.PAYLOADS.put(
            artifactAssetKey(artifactId, input.version, file.path),
            file.bytes,
            {
              httpMetadata: { contentType: assetContentType(file.path) },
              customMetadata: { source: "artifact", artifactId, version: String(input.version) },
            },
          );
        } catch (error) {
          uploadFailed = true;
          throw error;
        }
      }
    });
    // Drain every writer even on failure: no upload outlives this attempt, and
    // the manifest cannot make a version visible until all its assets exist.
    const results = await Promise.allSettled(uploads);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  } catch {
    throw new TerminalToolError(
      "resource_publish_failed",
      "The site's files could not be stored. Retry publish_resource with the same directory.",
      { reason: "Retry the same publish_resource call." },
    );
  }

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestRef = artifactManifestKey(artifactId, input.version);
  try {
    await env.PAYLOADS.put(manifestRef, manifestBytes, {
      httpMetadata: { contentType: SITE_MANIFEST_MIME_TYPE },
      customMetadata: { source: "artifact", artifactId, version: String(input.version) },
    });
  } catch {
    throw new TerminalToolError(
      "resource_publish_failed",
      "The site's manifest could not be stored. Retry publish_resource with the same directory.",
      { reason: "Retry the same publish_resource call." },
    );
  }

  return {
    artifactId,
    manifest,
    manifestBytes,
    manifestSha256: await sha256Hex(manifestBytes),
    manifestRef,
  };
}

/**
 * Point the supervisor object at the version whose bytes are now durable.
 *
 * Last, deliberately. Until this returns the artifact serves its previous
 * version; after it returns the new one is what every open resolves to. There
 * is no window where the pointer names bytes that are not there.
 *
 * The placement affinity is read here and passed down because this is the
 * artifact object's **first** lookup — Cloudflare honours a location hint only
 * then, and the serving Worker holds only platform D1—not the regional
 * workspace routing row needed to derive one. Skipping it would mint artifact objects a continent away
 * from the work streams they check visibility against.
 */
export async function pointArtifactAtVersion(
  env: Env,
  input: {
    artifactId: string;
    workspaceId: string;
    workstreamId: string;
    resourceId: string;
    region: Region;
    manifest: ArtifactManifest;
  },
): Promise<{ advanced: boolean }> {
  const affinity = await workspacePlacementAffinity(env, input.workspaceId);
  const host = durableObjectStubForArtifact(
    env,
    env.ARTIFACT_HOSTS,
    artifactHostDOName(env.AVALON_REGION, asArtifactId(input.artifactId)),
    affinity,
  );
  return host.recordPublish({
    artifactId: input.artifactId,
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    resourceId: input.resourceId,
    region: input.region,
    manifest: input.manifest,
  });
}

/**
 * Record the artifact beside the resource authority, or advance its version.
 *
 * A per-workspace index for listing, the revocation fan-out, and cleanup. The
 * shared platform D1 `artifact_hostname_routes` table reserves the public stub; this
 * row records the already-reserved value beside the resource authority.
 *
 * Never backwards: a writer holding an older version than the row (a publish
 * that stalled past a later one, or a retry reconciling from a stale read)
 * changes nothing, and answers `false`. The same version again is admitted,
 * so a retry that re-registers what it already wrote converges.
 */
export async function registerArtifact(
  workspace: D1Database,
  input: {
    artifactId: string;
    hostnameStub: ArtifactHostnameStub;
    workspaceId: string;
    workstreamId: string;
    resourceId: string;
    mode: ArtifactMode;
    stateful: boolean;
    version: number;
    manifestRef: string;
  },
): Promise<boolean> {
  const now = Date.now();
  const written = await workspace.prepare(
    `INSERT INTO artifact_registry (
       artifact_id, workspace_id, workstream_id, resource_id, mode, stateful,
       current_version, manifest_ref, hostname_stub, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(artifact_id) DO UPDATE SET
       mode = excluded.mode,
       stateful = excluded.stateful,
       current_version = excluded.current_version,
       manifest_ref = excluded.manifest_ref,
       hostname_stub = excluded.hostname_stub,
       updated_at = excluded.updated_at
     WHERE excluded.current_version >= artifact_registry.current_version
     RETURNING artifact_id`,
  ).bind(
    input.artifactId,
    input.workspaceId,
    input.workstreamId,
    input.resourceId,
    input.mode,
    input.stateful ? 1 : 0,
    input.version,
    input.manifestRef,
    input.hostnameStub,
    now,
    now,
  ).first<{ artifact_id: string }>();
  // The returned row is the witness: a refused upsert returns none
  // (`docs/durable-object-sqlite.md#mutation-outcomes-use-returned-witnesses`).
  return written?.artifact_id === input.artifactId;
}

/**
 * Take version `from`, or the first free one after it, for this artifact
 * before any of its bytes are written, and answer the version taken.
 *
 * Two publishes of one site that start together read the same registry
 * version and would write the same version-immutable keys
 * (`artifactAssetKey`), each overwriting the other's files, so whichever
 * manifest won would serve a mix. The claim is a create-once R2 object
 * (`If-None-Match: *`, which R2 evaluates atomically with the write, so of
 * two concurrent claims at most one succeeds), and the version's keys are
 * written only by its claimant. Chosen over conditional puts on every asset,
 * which cannot tell this call's own retried upload from a rival's, and over a
 * reservation column, which is a migration for what one object answers: it
 * costs one write per publish and keeps the serving key layout as it is. A
 * claim left by an attempt that failed is skipped, not reused, so versions
 * may have gaps; nothing reads them as contiguous.
 */
export async function claimArtifactVersion(
  env: Pick<Env, "PAYLOADS">,
  input: { artifactId: string; from: number; claimant: string },
): Promise<number> {
  for (let version = input.from; ; version += 1) {
    const claimed = await env.PAYLOADS.put(artifactVersionClaimKey(input.artifactId, version), input.claimant, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      customMetadata: { source: "artifact", artifactId: input.artifactId, version: String(version) },
    });
    if (claimed) return version;
  }
}

/** Beside the version's manifest and assets, and never served: the host reads only `assets` keys. */
function artifactVersionClaimKey(artifactId: string, version: number): string {
  return `artifact/${artifactId}/v${version}/claim`;
}

/** The artifact a republished path already has, if it has one. */
export async function existingArtifactForResource(
  workspace: D1Database,
  workspaceId: string,
  resourceId: string,
): Promise<{
  artifactId: string;
  version: number;
  mode: ArtifactMode;
  hostnameStub: ArtifactHostnameStub | null;
} | null> {
  const row = await workspace.prepare(
    `SELECT artifact_id, current_version, mode, hostname_stub FROM artifact_registry
      WHERE workspace_id = ? AND resource_id = ?`,
  ).bind(workspaceId, resourceId).first<{
    artifact_id: string;
    current_version: number;
    mode: string;
    hostname_stub: string | null;
  }>();
  if (!row) return null;
  return {
    artifactId: row.artifact_id,
    version: row.current_version,
    mode: row.mode === "active" ? "active" : "static",
    hostnameStub: row.hostname_stub === null
      ? null
      : ArtifactHostnameStubSchema.parse(row.hostname_stub),
  };
}

/** The artifact a resource already serves, as {@link existingArtifactForResource} answers it. */
export type ServedArtifact = NonNullable<Awaited<ReturnType<typeof existingArtifactForResource>>>;

/**
 * Publish one version of a site, in the one order that is safe.
 *
 * Every publisher of a site calls this: Rally's own publish
 * (`resource-bridge.ts`), a person's (`canvas-publication-service.ts`) and a
 * Canvas seed's (`canvas-seed-service.ts`). They differ in whose bytes these
 * are, who the revision's author is, and what a lost race means to them, and
 * all of that is in `recordResource`, the one step each writes for itself.
 * The order around it is here once, so it cannot drift between them:
 *
 * 1. Claim the version, when the site already serves one.
 * 2. Write the version's files and manifest.
 * 3. Reserve the public hostname.
 * 4. `recordResource`: the caller's insert or swap of the resource row.
 * 5. Register the artifact and point the host at the version
 *    ({@link activateSiteVersion}).
 *
 * `recordResource` answers `false` when another publish moved the row first.
 * Nothing is registered or pointed then: the winner's manifest is the site's,
 * and activating this one would serve a manifest the row does not hold.
 */
export async function publishSiteVersion(env: Env, workspace: D1Database, input: {
  workspaceId: string;
  workstreamId: string;
  resourceId: string;
  /** What the resource serves now, or `null` for its first version. */
  previous: ServedArtifact | null;
  /** The first version's artifact id, for a caller that names its own; minted when absent. */
  artifactId?: string;
  /** Who is taking the next version: the call's own id, so a retry of it is told from a rival. */
  claimant: string;
  mode: ArtifactMode;
  stateful: boolean;
  files: readonly SitePublishFile[];
  fallbackTitle: string;
  serverModuleSha256: string | null;
  recordResource: (version: { written: SitePublishResult; version: number; hostnameStub: ArtifactHostnameStub }) => Promise<boolean>;
}): Promise<{ landed: boolean; written: SitePublishResult; version: number; hostnameStub: ArtifactHostnameStub }> {
  const { previous } = input;
  // A republish takes its version before writing a byte of it, so two
  // publishes of one site never write the same version's keys.
  const version = previous
    ? await claimArtifactVersion(env, { artifactId: previous.artifactId, from: previous.version + 1, claimant: input.claimant })
    : 1;
  const written = await writeArtifactVersion(env, {
    workspaceId: input.workspaceId, workstreamId: input.workstreamId, region: env.AVALON_REGION,
    artifactId: previous?.artifactId ?? input.artifactId ?? null, resourceId: input.resourceId, version,
    mode: input.mode, stateful: input.stateful, files: input.files,
    fallbackTitle: input.fallbackTitle, serverModuleSha256: input.serverModuleSha256,
  });
  // The public origin before the row. If D1 is unavailable after the row
  // moves, a retry sees equal content, and would otherwise answer with the
  // previous version without ever registering or pointing at these bytes.
  const hostnameStub = previous?.hostnameStub ?? await ensureArtifactHostname(env, {
    workspaceId: input.workspaceId, artifactId: written.artifactId,
  });
  const landed = await input.recordResource({ written, version, hostnameStub });
  if (landed) {
    await activateSiteVersion(env, workspace, {
      workspaceId: input.workspaceId, workstreamId: input.workstreamId, resourceId: input.resourceId,
      manifest: written.manifest, hostnameStub, registeredVersion: previous?.version ?? null,
    });
  }
  return { landed, written, version, hostnameStub };
}

/**
 * Make a version whose resource row has landed the one the site serves:
 * register it beside the resource, then point the host at it.
 *
 * The last two steps of {@link publishSiteVersion}, and on their own the
 * repair for a publish that stopped between the row and the pointer: a retry
 * with unchanged content, or a resumed seed, calls this with the manifest the
 * row holds. Both writes only move forward, so a stale caller changes
 * nothing. Answers whether either moved.
 */
export async function activateSiteVersion(env: Env, workspace: D1Database, input: {
  workspaceId: string;
  workstreamId: string;
  resourceId: string;
  manifest: ArtifactManifest;
  /** The reserved hostname when the caller holds it; reserved here otherwise, which is idempotent. */
  hostnameStub?: ArtifactHostnameStub | null;
  /** The version the registry holds now, or `null` when it holds none: registering is skipped when it is not behind. */
  registeredVersion: number | null;
}): Promise<{ registered: boolean; advanced: boolean }> {
  const { manifest } = input;
  let registered = false;
  if (input.registeredVersion === null || input.registeredVersion < manifest.artifactVersion) {
    const hostnameStub = input.hostnameStub ?? await ensureArtifactHostname(env, {
      workspaceId: input.workspaceId, artifactId: manifest.artifactId,
    });
    registered = await registerArtifact(workspace, {
      artifactId: manifest.artifactId, hostnameStub, workspaceId: input.workspaceId, workstreamId: input.workstreamId,
      resourceId: input.resourceId, mode: manifest.mode, stateful: manifest.stateful, version: manifest.artifactVersion,
      manifestRef: artifactManifestKey(manifest.artifactId, manifest.artifactVersion),
    });
  }
  // Last, and only once every byte it names is durable. Until this returns
  // the site serves its previous version; there is no window where the
  // pointer names bytes a viewer cannot read.
  const pointed = await pointArtifactAtVersion(env, {
    artifactId: manifest.artifactId, workspaceId: input.workspaceId, workstreamId: input.workstreamId,
    resourceId: input.resourceId, region: env.AVALON_REGION, manifest,
  });
  return { registered, advanced: pointed.advanced };
}
