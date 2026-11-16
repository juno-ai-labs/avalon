import { DEFAULT_MAX_ATTACHMENT_BYTES } from "@rally/contracts";
import {
  ArtifactManifestSchema,
  SITE_MANIFEST_MIME_TYPE,
  asWorkspaceId,
  classifyAttachmentKind,
} from "@rally/contracts";
import type { CanvasPublishContent, CanvasPublishRequest, CanvasPublishedArtifact } from "@rally/contracts/canvases";
import { newId, nowIso } from "@rally/db";

import { workspaceDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { numericEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { sha256Hex } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { verifyAttachmentMimeType } from "./attachment-mime-verification";
import { ConversationService } from "./conversation-service";
import { conversationCanonicalUrl } from "./conversation-link-service";
import { putStagedResourceObject } from "./resource-object-cleanup";
import {
  insertPublishedResource,
  normalizePublishPath,
  publicationIdentity,
  publishedRowByIdentity,
  PublicationWriteFailed,
  settleStagedObject,
  swapPublishedContent,
  type PublicationAuthor,
} from "./resource-publication";
import { allocateResourceSlugBesideCreation } from "./resource-slug";
import { activateSiteVersion, existingArtifactForResource, publishSiteVersion } from "./terminal/site-resource-bridge";
import { TerminalToolError } from "./terminal/tools";
import { attachWorkstreamRuntimeResource } from "./workstream-object-client";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";
import { CanvasBuildService } from "./canvas-build/canvas-build-service";
import { detectSiteSource } from "@rally/contracts/canvas-build";

/**
 * A person publishing something made elsewhere into a Canvas: a document or
 * a static site from Claude, ChatGPT or OpenCode, through the MCP server or
 * any other client. It lands as an artifact of the Canvas exactly as Rally's
 * own publish does, through the same writes (`resource-publication.ts`), with
 * the person as the revision's author and the Canvas's last editor.
 *
 * Its identity is the Canvas and the name it is published under, so
 * publishing the same name again is a new version of the same artifact, and
 * a retry of a call that landed changes nothing. `docs/rally-mcp.md#publishing`.
 */
export class CanvasPublicationService {
  constructor(private readonly env: Env, private readonly auth: AuthContext,
    /** What builds a component or project; the Canvas's Terminal sandbox unless a test passes another. */
    private readonly builder?: Pick<CanvasBuildService, "build">) {}

  async publish(canvasId: string, request: CanvasPublishRequest, signal?: AbortSignal): Promise<CanvasPublishedArtifact> {
    // The person must be able to take part in the Canvas; a Sidekick's
    // conversation is not a Canvas, and an archived parent takes no writes.
    const parent = await new ConversationService(this.env, this.auth).authorizeViewer(canvasId);
    if (parent.kind !== "canvas") throw new ApiError(404, "canvas_not_found", "That Canvas could not be found");
    if (parent.archived) throw new ApiError(409, "conversation_parent_archived", "This Canvas is archived");

    const runtime = withWorkspaceRuntimeDatabase(this.env, this.auth.workspaceId);
    const name = normalizePublishPath(request.name);
    const providerResourceId = await publicationIdentity("canvas", canvasId, name);
    const existing = await publishedRowByIdentity(runtime.DB, this.auth.workspaceId, providerResourceId);
    const wanted = request.kind === "site" ? "generated_site" : "generated_file";
    if (existing && existing.resource_type !== wanted) {
      throw new ApiError(409, "canvas_artifact_kind_changed",
        `${name} is already published as a ${existing.resource_type === "generated_site" ? "site" : "file"} in this Canvas; publish it under another name`);
    }
    const author: PublicationAuthor = { kind: "member", userId: this.auth.userId };
    const operationId = newId();
    const published = await (request.kind === "file"
      ? this.publishFile(runtime, canvasId, name, providerResourceId, existing, request, author, operationId)
      : this.publishSite(runtime, canvasId, name, providerResourceId, existing, request, author, operationId, signal)
    ).catch((error: unknown) => {
      if (error instanceof PublicationWriteFailed) {
        throw new ApiError(503, `canvas_publish_${error.operation}_failed`, "The artifact could not be recorded. Publish it again with the same name.");
      }
      // The site writer refuses in the terminal tool's vocabulary; its code
      // and sentence hold for a person too.
      if (error instanceof TerminalToolError) throw new ApiError(422, error.code, error.message);
      throw error;
    });
    // Whether an unchanged site publish finished serving a half-done one.
    const { completed, ...answer } = { completed: false, ...published };

    // Attach on every outcome, an unchanged one included: a call retried
    // after it wrote the row but before attaching finishes it. The read
    // beside it answers whether the Canvas already lists the artifact.
    const [, version] = await Promise.all([
      attachWorkstreamRuntimeResource(runtime, {
        workspaceId: this.auth.workspaceId, workstreamId: canvasId, substreamId: "0",
        resourceId: published.resourceId, attachedByUserId: this.auth.userId,
        ...(published.outcome === "updated" ? { eventType: "resource_updated" as const } : {}),
      }).catch((error: unknown) => {
        const code = error instanceof Error ? error.message : "";
        if (code !== "resource_already_attached" && code !== "conflict") throw error;
      }),
      runtime.DB.prepare(`SELECT current_version,
          EXISTS (SELECT 1 FROM canvas_artifacts WHERE canvas_id = ? AND resource_id = resources.id) AS listed
          FROM resources WHERE id = ? AND workspace_id = ?`)
        .bind(canvasId, published.resourceId, this.auth.workspaceId).first<{ current_version: number | null; listed: number }>(),
    ]);
    // The note moves the Canvas's recency and last editor, clears the run
    // that last wrote it, and tells its pinners, so an unchanged republish
    // owes it only when this call finished something: a site whose serving it
    // just completed, or an artifact the Canvas does not list yet (the call
    // that wrote it stopped before noting). A republish of identical content
    // is not an edit by whoever repeated it.
    if (published.outcome !== "unchanged" || completed || !version?.listed) {
      const workspace = await durableObjectStubForWorkspace(this.env, this.env.WORKSPACE_DOS, this.auth.workspaceId,
        workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(this.auth.workspaceId)));
      // A Canvas holds one artifact, and a person publishing into it is
      // choosing what it shows: theirs replaces whatever it held.
      await workspace.canvasNoteArtifact({ workspaceId: this.auth.workspaceId, canvasId, resourceId: published.resourceId,
        editor: { kind: "person", id: this.auth.userId }, replace: true });
    }
    const url = await conversationCanonicalUrl(this.env, { region: this.env.AVALON_REGION, workspaceId: this.auth.workspaceId,
      parentId: canvasId, artifactId: published.resourceId }).catch(() => null);
    return { ...answer, kind: request.kind, version: version?.current_version ?? 1, url };
  }

  private maximumBytes(): number {
    return numericEnv(this.env, "MAX_ATTACHMENT_BYTES", DEFAULT_MAX_ATTACHMENT_BYTES);
  }

  private async publishFile(runtime: Env, canvasId: string, name: string, providerResourceId: string,
    existing: Awaited<ReturnType<typeof publishedRowByIdentity>>, request: Extract<CanvasPublishRequest, { kind: "file" }>,
    author: PublicationAuthor, operationId: string) {
    this.assertSize(smallestDecodedSize(request.content));
    const bytes = decode(request.content, "content");
    if (bytes.byteLength === 0) throw new ApiError(422, "attachment_empty", "There is nothing to publish");
    this.assertSize(bytes.byteLength);
    const sourceName = name.split("/").at(-1) ?? name;
    const mimeType = verifyAttachmentMimeType(bytes, sourceName, request.mimeType ?? null);
    const attachmentKind = classifyAttachmentKind({ mimeType, fileName: sourceName });
    const contentMode = attachmentKind === "image" ? "view" : attachmentKind === "audio" || attachmentKind === "other" ? "unsupported" : "read";
    const derivativeStatus = attachmentKind === "audio" || attachmentKind === "other" ? "unsupported" : "pending";
    const digest = await sha256Hex(bytes);
    const receipt = { publicationOperationId: operationId, publicationEventType: existing ? "resource_updated" : "resource_attached" };

    if (existing) {
      if (existing.content_sha256 === digest) return { resourceId: existing.id, title: existing.title, outcome: "unchanged" as const };
      const updated = await swapPublishedContent({
        workspace: runtime.DB, env: runtime, workspaceId: this.auth.workspaceId, existing,
        sourcePath: name, objectSource: "person", displayName: request.title, description: request.description,
        bytes, digest, mimeType, attachmentKind, contentMode, derivativeStatus, author, receipt,
      });
      if (updated.superseded) return supersededOutcome(updated, digest);
      return { resourceId: updated.id, title: updated.title, outcome: "updated" as const };
    }

    const resourceId = newId();
    const timestamp = nowIso();
    const objectRef = `${this.env.AVALON_REGION}/${this.auth.workspaceId}/resources/${resourceId}/published/${digest}/${newId()}`;
    await putStagedResourceObject({
      database: runtime.DB, payloads: this.env.PAYLOADS, objectRef, workspaceId: this.auth.workspaceId, resourceId,
      objectKind: "original", value: bytes,
      options: { httpMetadata: { contentType: mimeType }, customMetadata: { source: "person", sourcePath: name } },
      at: timestamp,
    });
    const title = [...(request.title ?? sourceName)].slice(0, 300).join("");
    await insertPublishedResource(runtime.DB, {
      publicationParentId: canvasId,
      resourceId, workspaceId: this.auth.workspaceId, resourceType: "generated_file", providerResourceId, title, mimeType,
      contentRef: objectRef, contentSha256: digest, uploadedByUserId: this.auth.userId, modelContentStatus: derivativeStatus,
      timestamp, author,
      metadataJson: JSON.stringify({ sourcePath: name, size: bytes.byteLength, attachmentKind, contentMode, ...receipt,
        ...(request.description ? { description: request.description } : {}) }),
    });
    await settleStagedObject(runtime.DB, this.auth.workspaceId, objectRef);
    await allocateResourceSlugBesideCreation(runtime, this.auth.workspaceId, resourceId);
    return { resourceId, title, outcome: "created" as const };
  }

  private async publishSite(runtime: Env, canvasId: string, name: string, providerResourceId: string,
    existing: Awaited<ReturnType<typeof publishedRowByIdentity>>, request: Extract<CanvasPublishRequest, { kind: "site" }>,
    author: PublicationAuthor, operationId: string, signal?: AbortSignal) {
    this.assertSize(request.files.reduce((total, file) => total + smallestDecodedSize(file.content), 0));
    const files = await Promise.all(request.files.map(async (file, index) => {
      const bytes = decode(file.content, `files.${index}.content`);
      return { path: normalizePublishPath(file.path), bytes, sha256: await sha256Hex(bytes) };
    }));
    this.assertSize(files.reduce((total, file) => total + file.bytes.byteLength, 0));
    // What the files are, from the files alone, before any sandbox starts.
    const source = detectSiteSource(files.map((file) => ({ path: file.path,
      text: /\.(?:html?|jsx?|tsx?|mjs|json)$/u.test(file.path) ? new TextDecoder().decode(file.bytes) : null })));
    if (source.kind === "refused") throw new ApiError(422, source.code, source.message);
    // The site's identity is the files it was published from, not the
    // manifest that describes them (which carries a version number and a
    // timestamp), and for a built site not what the build made: an unchanged
    // component republished is unchanged without starting a sandbox.
    const contentDigest = await sha256Hex(new TextEncoder().encode(JSON.stringify(
      [...files].sort((left, right) => left.path.localeCompare(right.path)).map((file) => [file.path, file.sha256]),
    )));
    const previous = existing ? await existingArtifactForResource(runtime.DB, this.auth.workspaceId, existing.id) : null;
    if (existing && previous && existing.content_sha256 === contentDigest) {
      const completed = await this.reconcileServing(runtime, canvasId, existing, previous);
      return { resourceId: existing.id, title: existing.title, outcome: "unchanged" as const, completed };
    }
    const built = source.kind === "static" ? null
      : await (this.builder ?? new CanvasBuildService(this.env, this.auth)).build(canvasId, source, files, signal);
    const served = built?.files ?? files;
    const build = built && source.kind !== "static"
      ? { source: source.kind, files: built.files.length, renderedTextLength: built.renderedTextLength } : undefined;
    const resourceId = existing?.id ?? newId();
    const title = [...(request.title ?? name.split("/").at(-1) ?? "site")].slice(0, 300).join("");
    const receipt = { publicationOperationId: operationId, publicationEventType: existing ? "resource_updated" : "resource_attached" };
    // What another publish left on the row, when it moved the row first.
    const lost: { to: Awaited<ReturnType<typeof swapPublishedContent>> | null } = { to: null };
    // The version, its bytes, the hostname, the registry and the pointer are
    // `publishSiteVersion`'s, in its order. This publish's own part is the
    // resource row, with the person as its author.
    const { landed } = await publishSiteVersion(runtime, runtime.DB, {
      workspaceId: this.auth.workspaceId, workstreamId: canvasId, resourceId,
      previous, claimant: operationId, mode: "static", stateful: false,
      files: served, fallbackTitle: title, serverModuleSha256: null,
      recordResource: async ({ written, version }) => {
        if (existing) {
          const swapped = await swapPublishedContent({
            workspace: runtime.DB, env: runtime, workspaceId: this.auth.workspaceId, existing,
            sourcePath: name, objectSource: "person", displayName: request.title, description: request.description,
            bytes: written.manifestBytes, digest: contentDigest, mimeType: SITE_MANIFEST_MIME_TYPE,
            attachmentKind: "site", contentMode: "unsupported", derivativeStatus: "unsupported", author, receipt,
          });
          // Another publish moved the row first: its manifest is the site's, and
          // it registers and points at it. Activating this call's version now
          // would serve a manifest the row does not hold.
          if (swapped.superseded) lost.to = swapped;
          return !swapped.superseded;
        }
        await insertPublishedResource(runtime.DB, {
          publicationParentId: canvasId,
          resourceId, workspaceId: this.auth.workspaceId, resourceType: "generated_site", providerResourceId, title,
          mimeType: SITE_MANIFEST_MIME_TYPE, contentRef: written.manifestRef, contentSha256: contentDigest,
          uploadedByUserId: this.auth.userId, modelContentStatus: "unsupported", timestamp: nowIso(), author,
          metadataJson: JSON.stringify({ sourcePath: name, size: written.manifest.totalBytes, attachmentKind: "site",
            contentMode: "unsupported", ...receipt, artifactId: written.artifactId, artifactVersion: version,
            artifactMode: "static", artifactStateful: false, ...(request.description ? { description: request.description } : {}) }),
        });
        await allocateResourceSlugBesideCreation(runtime, this.auth.workspaceId, resourceId);
        return true;
      },
    });
    if (!landed && lost.to) return supersededOutcome(lost.to, contentDigest);
    return { resourceId, title: existing?.title ?? title, outcome: existing ? "updated" as const : "created" as const,
      ...(build ? { build } : {}) };
  }

  /**
   * Finish a site publish that stopped after its resource row moved: the row
   * holds the new version's manifest, but the registry or the serving pointer
   * may still name the old one. A retry with the same content is unchanged,
   * so it is the retry's job to bring both up to the manifest the row holds.
   * Pointing is an upsert, so doing it again for a site already pointed
   * changes nothing. `existing` and `previous` may be stale by the time this
   * writes, and a later publish may have moved both; the registry and the
   * host each refuse a version older than their own, so this can only move
   * them forward. Answers whether it moved either.
   */
  private async reconcileServing(runtime: Env, canvasId: string,
    existing: NonNullable<Awaited<ReturnType<typeof publishedRowByIdentity>>>,
    previous: NonNullable<Awaited<ReturnType<typeof existingArtifactForResource>>>): Promise<boolean> {
    if (!existing.content_ref) return false;
    const stored = await this.env.PAYLOADS.get(existing.content_ref);
    if (!stored) return false;
    const manifest = ArtifactManifestSchema.parse(JSON.parse(await stored.text()) as unknown);
    if (manifest.artifactId !== previous.artifactId) return false;
    const activated = await activateSiteVersion(runtime, runtime.DB, {
      workspaceId: this.auth.workspaceId, workstreamId: canvasId, resourceId: existing.id,
      manifest, hostnameStub: previous.hostnameStub, registeredVersion: previous.version,
    });
    return activated.registered || activated.advanced;
  }

  private assertSize(bytes: number) {
    const maximum = this.maximumBytes();
    if (bytes > maximum) throw new ApiError(413, "attachment_too_large", `This is ${bytes} bytes; an artifact may be at most ${maximum}`);
  }
}

/**
 * What a publish that lost the row's compare-and-swap answers. The same
 * content is what the winner published, so this call's intent landed:
 * `unchanged`. Other content means the person's publish is not what the
 * artifact holds, which is theirs to decide: publish again to replace it.
 */
function supersededOutcome(current: { id: string; title: string; content_sha256: string | null }, digest: string) {
  if (current.content_sha256 === digest) return { resourceId: current.id, title: current.title, outcome: "unchanged" as const };
  throw new ApiError(409, "canvas_publish_conflict",
    "Another publish of this name landed first. Publish it again to replace it.");
}

/**
 * The fewest bytes `content` can decode to, read from its length alone, so
 * an oversized publish is refused before a copy is made. Text is at least one
 * UTF-8 byte per UTF-16 unit; base64 with no whitespace is three bytes per
 * four characters, less padding. Base64 with whitespace counts as no bytes
 * here and is measured once decoded.
 */
export function smallestDecodedSize(content: CanvasPublishContent): number {
  if (content.encoding === "text") return content.data.length;
  if (/\s/u.test(content.data)) return 0;
  return Math.max(0, Math.floor(content.data.length * 3 / 4) - 2);
}

/**
 * Text as UTF-8, or base64 (standard or URL-safe), named by its field when it
 * will not decode. Decoded in one pass where the runtime has
 * `Uint8Array.fromBase64`: a 25 MB artifact is a 33 MB string, and every
 * intermediate copy of it counts against the isolate's 128 MB.
 */
function decode(content: CanvasPublishContent, field: string): Uint8Array {
  if (content.encoding === "text") return new TextEncoder().encode(content.data);
  const urlSafe = content.data.includes("-") || content.data.includes("_");
  try {
    const fromBase64: unknown = Reflect.get(Uint8Array, "fromBase64");
    const data = /\s/u.test(content.data) ? content.data.replace(/\s+/gu, "") : content.data;
    if (typeof fromBase64 === "function") {
      const decoded: unknown = Reflect.apply(fromBase64, Uint8Array,
        [data, { alphabet: urlSafe ? "base64url" : "base64", lastChunkHandling: "loose" }]);
      if (decoded instanceof Uint8Array) return decoded;
    }
    const binary = atob(urlSafe ? data.replaceAll("-", "+").replaceAll("_", "/") : data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new ApiError(422, "canvas_publish_content_invalid", `canvas_publish_content_invalid:${field}:base64`);
  }
}
