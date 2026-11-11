import {
  ArtifactManifestSchema,
  type ArtifactManifest,
  RegionSchema,
  SITE_MANIFEST_MIME_TYPE,
  artifactManifestKey,
  asUserId,
  asWorkspaceId,
  type WorkstreamAppearance,
} from "@rally/contracts";
import { nowIso } from "@rally/db";
import { z } from "zod";

import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { sha256Hex } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { diagnosticErrorCode, logError } from "../observability/logger";
import { createMessageObjectPort } from "../runtime/message-port";
import { ensureArtifactHostname } from "./artifact-hostname";
import { createCanvas } from "./canvas-service";
import { insertPublishedResource, publicationIdentity, publishedRowByIdentity } from "./resource-publication";
import { allocateResourceSlugBesideCreation } from "./resource-slug";
import { declaresStorageClass } from "./terminal/site-publish";
import {
  existingArtifactForResource,
  pointArtifactAtVersion,
  registerArtifact,
  writeArtifactVersion,
} from "./terminal/site-resource-bridge";
import { attachWorkstreamRuntimeResource } from "./workstream-object-client";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";

/**
 * A Canvas Rally makes for an Organization rather than a person starting it:
 * its title and look, the first message of its Chat, and one site.
 *
 * A seed is data. Everything that makes it a Canvas is the product's own
 * creation, publication and message path, called in order by
 * {@link seedCanvas}; nothing downstream can tell a seeded Canvas from one a
 * person started and Rally published into. `docs/canvas-seeds.md`.
 */
export interface CanvasSeed {
  /** Stable for the life of the seed: the Canvas, its artifact and its opening message are all named from it. */
  key: string;
  title: string;
  appearance: WorkstreamAppearance;
  /** What Rally says first, written to the Chat without a run. */
  openingMessage: string;
  site: {
    /** The path Rally's own publish would name, so a later republish from the Chat is this artifact's next version. */
    path: string;
    files: readonly { path: string; text: string }[];
  };
}

export const CanvasSeedQueueSchema = z.strictObject({
  kind: z.literal("canvas_seed"),
  workspaceId: z.string().uuid(),
  creatorUserId: z.string().uuid(),
  seedKey: z.string().min(1),
  region: RegionSchema,
});
export type CanvasSeedQueueMessage = z.infer<typeof CanvasSeedQueueSchema>;

/**
 * Ask for a seed to be copied into an Organization, and walk away.
 *
 * A queue rather than a call: creating an Organization must not wait on a
 * Canvas, a publish and a message, and the queue owns the retry. A send that
 * fails is logged and swallowed, because the Organization exists either way
 * and a person must not be refused their Organization over a missing guide.
 */
export async function enqueueCanvasSeed(env: Env, input: { workspaceId: string; creatorUserId: string; seedKey: string }): Promise<void> {
  try {
    await env.ACTIVITY_QUEUE.send(CanvasSeedQueueSchema.parse({ kind: "canvas_seed", ...input, region: env.AVALON_REGION }));
  } catch (error) {
    logError(env, "canvas_seed_enqueue_failed", {
      workspace_id: input.workspaceId,
      seed_key: input.seedKey,
      error_code: diagnosticErrorCode(error, "canvas_seed_enqueue_failed"),
    });
  }
}

/**
 * A UUID that is the same every time for the same name, so a retried seed
 * finds what its first attempt made rather than making a second.
 */
async function namedId(name: string): Promise<string> {
  const hex = await sha256Hex(name);
  // Version 8 (RFC 9562, "custom") and the standard variant.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${"89ab"[Number.parseInt(hex[16]!, 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The Canvas a seed makes in one Organization. */
export function seededCanvasId(workspaceId: string, seedKey: string): Promise<string> {
  return namedId(`canvas-seed:${workspaceId}:${seedKey}`);
}

function openingMessageKey(seedKey: string): string {
  return `canvas-seed:${seedKey}:opening`;
}

/**
 * Copy a seed into an Organization as one Canvas, with `creatorUserId` as its
 * creator, open to every member.
 *
 * Safe to run again: every id is named from the Organization and the seed,
 * and each step answers a replay with what it already made. The opening
 * message is written last and is the mark that the seed finished, so a run
 * that finds it does nothing; a late replay therefore never undoes what
 * people did to the Canvas afterwards (its look, who can open it).
 */
export async function seedCanvas(env: Env, input: { workspaceId: string; creatorUserId: string }, seed: CanvasSeed): Promise<{ canvasId: string; seeded: boolean }> {
  const workspaceId = asWorkspaceId(input.workspaceId);
  const canvasId = await seededCanvasId(workspaceId, seed.key);
  const actor = { userId: asUserId(input.creatorUserId), actorRole: "owner" as const };

  const { created } = await createCanvas(env, { workspaceId, creatorUserId: input.creatorUserId, title: seed.title, canvasId });
  const messages = createMessageObjectPort(env, workspaceId, canvasId);
  const openingKey = openingMessageKey(seed.key);
  if (!created && await messages.messageByClientId({ clientMessageId: openingKey })) return { canvasId, seeded: false };

  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
    workspaceDOName(env.AVALON_REGION, workspaceId));
  await workspace.canvasUpdate({ workspaceId, canvasId, actor, appearance: seed.appearance });
  await publishSeedSite(env, { workspaceId, canvasId, seedKey: seed.key }, seed.site);
  await workspace.canvasSetAudience({ workspaceId, canvasId, actor, update: { visibility: "workspace", userIds: [] } });
  // Rally's words, with no run behind them: the same append a scheduled
  // wake-up's notice makes, authored as the agent.
  await messages.appendMessage({
    messageId: await namedId(`${openingKey}:${canvasId}`),
    clientMessageId: openingKey,
    authorType: "agent",
    authorUserId: null,
    externalActorJson: null,
    messageType: "text",
    text: seed.openingMessage,
    structuredContentJson: null,
    producedByRunId: null,
    now: Date.now(),
  });
  return { canvasId, seeded: true };
}

/**
 * Publish a seed's site as the Canvas's first artifact, at version 1.
 *
 * The third caller of the site writes, after Rally's own publish
 * (`terminal/resource-bridge.ts`) and a person's
 * (`canvas-publication-service.ts`), and the same order as both: files,
 * manifest, hostname, resource row, registry, pointer. It differs in two
 * ways. Its identity is the one Rally's publish of `site.path` from this
 * Canvas's Chat would compute, so the first time Rally revises the site that
 * is version 2 of this artifact and not a second site. And it only ever
 * writes version 1: a row that already holds other content was published
 * since, and is left alone.
 */
async function publishSeedSite(env: Env, target: { workspaceId: string; canvasId: string; seedKey: string }, site: CanvasSeed["site"]): Promise<void> {
  const { workspaceId, canvasId } = target;
  const runtime = withWorkspaceRuntimeDatabase(env, workspaceId);
  const providerResourceId = await publicationIdentity("terminal", canvasId, site.path);
  const files = await Promise.all([...site.files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(async (file) => {
      const bytes = new TextEncoder().encode(file.text);
      return { path: file.path, bytes, sha256: await sha256Hex(bytes) };
    }));
  const serverModule = files.find((file) => file.path === "index.js");
  const mode = serverModule ? "active" as const : "static" as const;
  const stateful = serverModule ? declaresStorageClass(new TextDecoder().decode(serverModule.bytes)) : false;
  const contentDigest = await sha256Hex(new TextEncoder().encode(JSON.stringify(files.map((file) => [file.path, file.sha256]))));

  const resourceId = await namedId(`canvas-seed-resource:${canvasId}:${site.path}`);
  const artifactId = await namedId(`canvas-seed-artifact:${canvasId}:${site.path}`);
  const existing = await publishedRowByIdentity(runtime.DB, workspaceId, providerResourceId);
  // A row that is not this seed's first version was published since: leave it.
  if (existing && (existing.id !== resourceId || existing.content_sha256 !== contentDigest)) return;

  let manifest: ArtifactManifest;
  if (existing) {
    // An earlier attempt wrote the row and stopped: finish from the manifest
    // the row holds, which is the one its bytes were stored under.
    const stored = existing.content_ref ? await env.PAYLOADS.get(existing.content_ref) : null;
    if (!stored) throw new Error("canvas_seed_manifest_missing");
    manifest = ArtifactManifestSchema.parse(JSON.parse(await stored.text()) as unknown);
  } else {
    const written = await writeArtifactVersion(env, {
      workspaceId, workstreamId: canvasId, region: env.AVALON_REGION,
      artifactId, resourceId, version: 1, mode, stateful,
      files, fallbackTitle: site.path, serverModuleSha256: serverModule?.sha256 ?? null,
    });
    manifest = written.manifest;
    // The public origin before the row, as every site publish orders it.
    await ensureArtifactHostname(env, { workspaceId, artifactId });
    await insertPublishedResource(runtime.DB, {
      publicationParentId: canvasId,
      resourceId, workspaceId, resourceType: "generated_site", providerResourceId,
      title: site.path, mimeType: SITE_MANIFEST_MIME_TYPE,
      contentRef: written.manifestRef, contentSha256: contentDigest,
      // No person published this, and no run did.
      uploadedByUserId: null, modelContentStatus: "unsupported", timestamp: nowIso(),
      author: { kind: "system" },
      metadataJson: JSON.stringify({
        sourcePath: site.path, size: written.manifest.totalBytes, attachmentKind: "site", contentMode: "unsupported",
        publicationEventType: "resource_attached", canvasSeed: target.seedKey,
        artifactId, artifactVersion: 1, artifactMode: mode, artifactStateful: stateful,
      }),
    });
    await allocateResourceSlugBesideCreation(runtime, workspaceId, resourceId);
  }

  const registered = await existingArtifactForResource(runtime.DB, workspaceId, resourceId);
  if (!registered) {
    await registerArtifact(runtime.DB, {
      artifactId: manifest.artifactId, hostnameStub: await ensureArtifactHostname(env, { workspaceId, artifactId: manifest.artifactId }),
      workspaceId, workstreamId: canvasId, resourceId: resourceId,
      mode: manifest.mode, stateful: manifest.stateful, version: manifest.artifactVersion,
      manifestRef: artifactManifestKey(manifest.artifactId, manifest.artifactVersion),
    });
  }
  // Last, once every byte it names is durable. Pointing is an upsert, so a
  // replay points a site that already serves at the version it serves.
  await pointArtifactAtVersion(env, {
    artifactId: manifest.artifactId, workspaceId, workstreamId: canvasId, resourceId: resourceId,
    region: env.AVALON_REGION, manifest,
  });

  await attachWorkstreamRuntimeResource(runtime, {
    workspaceId, workstreamId: canvasId, substreamId: "0", resourceId: resourceId, attachedByUserId: null,
  }).catch((error: unknown) => {
    const code = error instanceof Error ? error.message : "";
    if (code !== "resource_already_attached" && code !== "conflict") throw error;
  });
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)));
  await workspace.canvasNoteArtifact({ workspaceId, canvasId, resourceId: resourceId, editor: { kind: "rally", id: null } });
}

/**
 * One `canvas_seed` job: find the seed it names and copy it in.
 *
 * A key this Worker does not carry is thrown, never dropped: the job was sent
 * by a version that has the seed, and a retry or the dead-letter queue is how
 * it reaches one.
 */
export async function runCanvasSeed(env: Env, job: CanvasSeedQueueMessage, seeds: Readonly<Record<string, CanvasSeed>>) {
  const seed = seeds[job.seedKey];
  if (!seed) throw new Error("canvas_seed_unknown");
  return seedCanvas(env, { workspaceId: job.workspaceId, creatorUserId: job.creatorUserId }, seed);
}
