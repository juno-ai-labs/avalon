import {
  ArtifactManifestSchema,
  RegionSchema,
  SITE_MANIFEST_MIME_TYPE,
  asUserId,
  asWorkspaceId,
  type WorkspaceId,
  type WorkstreamAppearance,
} from "@rally/contracts";
import { nowIso } from "@rally/db";
import { z } from "zod";

import { workspaceDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { asApiError } from "../lib/api-error";
import { sha256Hex } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { diagnosticErrorCode, logError } from "../observability/logger";
import { createMessageObjectPort } from "../runtime/message-port";
import { createCanvas } from "./canvas-service";
import { ConversationService } from "./conversation-service";
import { insertPublishedResource, publicationIdentity, publishedRowByIdentity } from "./resource-publication";
import { allocateResourceSlugBesideCreation } from "./resource-slug";
import { declaresStorageClass } from "./terminal/site-publish";
import { activateSiteVersion, existingArtifactForResource, publishSiteVersion } from "./terminal/site-resource-bridge";
import { attachWorkstreamRuntimeResource } from "./workstream-object-client";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";

/**
 * A Canvas Rally makes for an Organization rather than a person starting it:
 * its title and look, the two messages that open its Chat, and one site.
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
  /**
   * What the Canvas's creator is recorded as having asked Rally for, which
   * opens the Chat. It is how a seed tells Rally what its site is for: the
   * transcript is the one thing every run reads, where a file in the site is
   * read only if Rally opens it. Every member sees it under the creator's
   * name, so it is written as that person would ask.
   */
  request: string;
  /** What Rally answers, written to the Chat without a run. */
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

function requestMessageKey(seedKey: string): string {
  return `canvas-seed:${seedKey}:request`;
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

  let created: boolean;
  try {
    ({ created } = await createCanvas(env, { workspaceId, creatorUserId: input.creatorUserId, title: seed.title, canvasId }));
  } catch (error) {
    // The guide exists and its owner archived it: nothing is owed, and a
    // replay must not retry its way into the dead-letter queue.
    if (asApiError(error)?.code === "canvas_archived") return { canvasId, seeded: false };
    throw error;
  }
  const messages = createMessageObjectPort(env, workspaceId, canvasId);
  const openingKey = openingMessageKey(seed.key);
  if (!created && await messages.messageByClientId({ clientMessageId: openingKey })) return { canvasId, seeded: false };

  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
    workspaceDOName(env.AVALON_REGION, workspaceId));
  await workspace.canvasUpdate({ workspaceId, canvasId, actor, appearance: seed.appearance });
  await recordSeedRequest(env, { workspaceId, canvasId, creatorUserId: input.creatorUserId }, seed);
  await publishSeedSite(env, { workspaceId, canvasId, seedKey: seed.key, title: seed.title }, seed.site);
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
 * Record the seed's request in the Chat as the creator's own message.
 *
 * Through the path a person's message takes, marked record-only so no run
 * starts: the creator asked for nothing just now, and Rally's answer is the
 * seed's opening message. The creator is checked as a current member, as
 * every non-session principal is, so a job replayed after they left writes no
 * request and the Chat opens on Rally's message instead.
 *
 * Looked up before it is sent: a replay with the same id and other words is
 * refused as an idempotency conflict, and a deploy between two attempts
 * changes the words.
 */
async function recordSeedRequest(env: Env, target: { workspaceId: WorkspaceId; canvasId: string; creatorUserId: string }, seed: CanvasSeed): Promise<void> {
  const { workspaceId, canvasId } = target;
  const clientMessageId = requestMessageKey(seed.key);
  if (await createMessageObjectPort(env, workspaceId, canvasId).messageByClientId({ clientMessageId })) return;
  const member = await env.DB.prepare(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
  ).bind(workspaceId, target.creatorUserId).first<{ role: AuthContext["role"] }>();
  if (!member) return;
  const auth: AuthContext = {
    sessionId: clientMessageId, workspaceId, userId: asUserId(target.creatorUserId),
    region: env.AVALON_REGION, role: member.role, principal: "canvas_seed",
  };
  const chat = await new ConversationService(env, auth).writableClient(canvasId);
  await chat.createMessage({
    text: seed.request, clientMessageId, recordOnly: true,
    mentions: [], confirmedParticipantUserIds: [], attachmentIds: [],
  });
}

/**
 * Publish a seed's site as the Canvas's first artifact, at version 1.
 *
 * Through `publishSiteVersion`, as Rally's own publish and a person's go, so
 * the order of the writes is theirs. What is the seed's own: the files come
 * from the Worker, with no sandbox; the revision's author is `system`; and
 * the identity is the one Rally's publish of `site.path` from this Canvas's
 * Chat would compute, so the first time Rally revises the site that is
 * version 2 of this artifact and not a second site. It only ever writes
 * version 1: a row whose stored manifest is past version 1 was published
 * since, and is left alone.
 */
async function publishSeedSite(env: Env, target: { workspaceId: string; canvasId: string; seedKey: string; title: string }, site: CanvasSeed["site"]): Promise<void> {
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
  if (existing && existing.id !== resourceId) return;

  if (existing) {
    // The row's own manifest says which case this is, where its bytes cannot:
    // a deploy between two attempts changes the seed's files, and comparing
    // them would read an unfinished first attempt as a later republish.
    const stored = existing.content_ref ? await env.PAYLOADS.get(existing.content_ref) : null;
    if (!stored) throw new Error("canvas_seed_manifest_missing");
    const manifest = ArtifactManifestSchema.parse(JSON.parse(await stored.text()) as unknown);
    // Past version 1, Rally published since, and that publish registered and
    // pointed its own version. At version 1 an earlier attempt wrote the row
    // and may have stopped: finish serving the bytes it stored.
    if (manifest.artifactVersion !== 1) return;
    const registered = await existingArtifactForResource(runtime.DB, workspaceId, resourceId);
    await activateSiteVersion(env, runtime.DB, {
      workspaceId, workstreamId: canvasId, resourceId, manifest,
      hostnameStub: registered?.hostnameStub ?? null, registeredVersion: registered?.version ?? null,
    });
  } else {
    await publishSiteVersion(env, runtime.DB, {
      workspaceId, workstreamId: canvasId, resourceId, previous: null, artifactId,
      claimant: `canvas-seed:${target.seedKey}`, mode, stateful,
      files, fallbackTitle: target.title, serverModuleSha256: serverModule?.sha256 ?? null,
      recordResource: async ({ written }) => {
        await insertPublishedResource(runtime.DB, {
          publicationParentId: canvasId,
          resourceId, workspaceId, resourceType: "generated_site", providerResourceId,
          // The Canvas's own name, not the directory's: it is what the panel
          // shows, and a later republish that names no title keeps it.
          title: target.title, mimeType: SITE_MANIFEST_MIME_TYPE,
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
        return true;
      },
    });
  }

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
