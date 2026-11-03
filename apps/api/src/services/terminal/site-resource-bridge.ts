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
import { assetContentType, declaresAnonymousSubmissions } from "./site-publish";
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
  // Read from the module like the storage class: the setting lives in the code
  // the model wrote, so changing it changes the content and republishes.
  const serverModule = serverEntry ? input.files.find((file) => file.path === serverEntry) : undefined;
  const anonymousSubmissions = serverModule
    ? declaresAnonymousSubmissions(new TextDecoder().decode(serverModule.bytes))
    : false;
  const manifest: ArtifactManifest = {
    version: 1,
    artifactId: asArtifactId(artifactId),
    artifactVersion: input.version,
    mode: input.mode,
    stateful: input.stateful,
    serverModuleSha256: input.serverModuleSha256,
    assets,
    socialPreview: preparedPreview.socialPreview,
    ...(anonymousSubmissions ? { anonymousSubmissions: true as const } : {}),
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
): Promise<void> {
  const affinity = await workspacePlacementAffinity(env, input.workspaceId);
  const host = durableObjectStubForArtifact(
    env,
    env.ARTIFACT_HOSTS,
    artifactHostDOName(env.AVALON_REGION, asArtifactId(input.artifactId)),
    affinity,
  );
  await host.recordPublish({
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
): Promise<void> {
  const now = Date.now();
  await workspace.prepare(
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
       updated_at = excluded.updated_at`,
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
  ).run();
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
