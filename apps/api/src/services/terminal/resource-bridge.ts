import { AttachmentKindSchema, classifyAttachmentKind, ResourceSchema } from "@rally/contracts";
import { newId, nowIso } from "@rally/db";

import type { Env } from "../../env";
import { numericEnv } from "../../env";
import { sha256Hex } from "../../lib/crypto";
import { verifyAttachmentMimeType } from "../attachment-mime-verification";
import {
  attachWorkstreamRuntimeResource,
  type WorkstreamRuntimeResourceAttacher,
} from "../workstream-object-client";
import { createResourceObjectPort } from "../../runtime/resource-port";
import { allocateResourceSlugBesideCreation } from "../resource-slug";
import { putStagedResourceObject, releaseStagedResourceObject } from "../resource-object-cleanup";
import { loadVisibleWorkstreamResourcesByIds } from "../workstream-resource-visibility";
import type { TerminalPortFactory } from "./object-port";
import type { TerminalSandboxProvider } from "./provider-contract";
import type { TerminalResourceBridge } from "./runtime";
import { requireTerminalEffectIntent, TerminalToolError, type TerminalPublishedResourceOutput } from "./tools";

interface PublishedRow {
  id: string;
  title: string;
  mime_type: string | null;
  content_ref: string | null;
  content_sha256: string | null;
  metadata_json: string;
  model_content_status: string | null;
  created_at: string;
}

function fileName(path: string): string {
  return path.split("/").at(-1) || "resource";
}

/**
 * The published path as the document's identity reads it.
 *
 * `terminal_publish_resource` already resolves its argument to this shape, so
 * for a model-driven publish this is the identity function. It is applied
 * anyway because the identity has to be one derivation rather than a promise
 * that every caller normalized first: `docs/./plan.md` and `docs/plan.md` are
 * the same file beneath the resource directory, and a document whose rail entry
 * depends on which spelling a call used is the sibling problem again.
 */
function normalizePublishPath(path: string): string {
  return path.split("/").filter((segment) => segment && segment !== ".").join("/");
}

/**
 * A published document's identity, bounded by the contract that publishes it.
 *
 * The path half is model-chosen and the tool accepts 4,096 characters of it,
 * while `ResourceSchema` bounds `providerResourceId` at 500 — so the readable
 * form is only safe while it fits. It is not a cosmetic overflow: the identity
 * is projected into `GET /workstreams/:id` and `GET /resources`, so one row
 * past the bound stops the work stream opening at all and fails the workspace's
 * resource list, and nothing in the product deletes a published row to recover.
 *
 * Past the bound the path is replaced by its digest rather than truncated.
 * Truncating would map two different long paths onto one document; the digest
 * keeps identity one-to-one with the path, which is the whole point of scoping
 * it to the path. `metadata_json.sourcePath` still carries the readable value.
 */
const PUBLISHED_IDENTITY_MAXIMUM = ResourceSchema.shape.providerResourceId.unwrap().maxLength ?? 500;

async function publishedResourceIdentity(workstreamId: string, filePath: string): Promise<string> {
  const readable = `terminal:${workstreamId}:${normalizePublishPath(filePath)}`;
  if (readable.length <= PUBLISHED_IDENTITY_MAXIMUM) return readable;
  const digest = await sha256Hex(new TextEncoder().encode(normalizePublishPath(filePath)));
  return `terminal:${workstreamId}:sha256:${digest}`;
}

function publishedOutput(row: PublishedRow, sizeBytes: number): TerminalPublishedResourceOutput {
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(row.metadata_json) as Record<string, unknown>; } catch { /* legacy metadata */ }
  const attachmentKind = AttachmentKindSchema.safeParse(metadata.attachmentKind);
  const contentMode = metadata.contentMode === "read" || metadata.contentMode === "view" || metadata.contentMode === "unsupported"
    ? metadata.contentMode
    : "unsupported";
  if (!row.content_sha256 || !/^[0-9a-f]{64}$/u.test(row.content_sha256)) {
    throw new TerminalToolError(
      "resource_publish_failed",
      "Rally could not verify the previously published resource identity. Retry publish_resource with the stable final file.",
      { reason: "Retry the same publish_resource call so Rally can reconcile its resource identity." },
    );
  }
  return {
    resourceId: row.id,
    title: row.title,
    resourceType: "generated_file" as const,
    provider: "avalon_generated" as const,
    mimeType: row.mime_type ?? "application/octet-stream",
    sizeBytes,
    sourceSha256: row.content_sha256,
    attachmentKind: attachmentKind.success ? attachmentKind.data : "other",
    contentMode,
    derivativeStatus: row.model_content_status === "ready" || row.model_content_status === "unsupported"
      ? row.model_content_status
      : "pending",
    createdAt: row.created_at,
  };
}

/**
 * Swap a republished document's content onto the row it already has.
 *
 * The shape is the connector re-fetch path's: pre-register the new object in
 * the cleanup outbox, write it, then compare-and-swap the pointer against the
 * one that was read, so a lost race deletes the object it wrote rather than
 * overwriting a newer publish. What the swap does *not* do is destroy the old
 * bytes — WorkspaceDO's version triggers capture the superseded state and the
 * reaper treats a ref a version still names as active, so a revision keeps its
 * predecessor readable instead of replacing the only copy.
 */
async function swapPublishedContent(input: {
  workspace: D1Database;
  env: Env;
  workspaceId: string;
  existing: PublishedRow;
  filePath: string;
  displayName?: string | undefined;
  description?: string | undefined;
  bytes: Uint8Array;
  digest: string;
  mimeType: string;
  attachmentKind: string;
  contentMode: string;
  derivativeStatus: string;
  harnessRunId: string;
}): Promise<PublishedRow> {
  const { workspace, env, workspaceId, existing, bytes, digest } = input;
  const timestamp = nowIso();
  const objectRef = `${env.AVALON_REGION}/${workspaceId}/resources/${existing.id}/terminal/${digest}/${newId()}`;
  let previousMetadata: Record<string, unknown> = {};
  try { previousMetadata = JSON.parse(existing.metadata_json) as Record<string, unknown>; } catch { /* legacy metadata */ }
  const description = input.description ?? (typeof previousMetadata.description === "string"
    ? previousMetadata.description
    : undefined);
  // A revision that names no title keeps the one participants already know the
  // document by; renaming it silently on every republish would be worse than
  // ignoring the argument.
  const title = input.displayName?.trim()
    ? [...input.displayName.trim()].slice(0, 300).join("")
    : existing.title;
  const metadata = JSON.stringify({
    sourcePath: input.filePath,
    size: bytes.byteLength,
    attachmentKind: input.attachmentKind,
    contentMode: input.contentMode,
    ...(description ? { description } : {}),
  });
  await putStagedResourceObject({
    database: workspace,
    payloads: env.PAYLOADS,
    objectRef,
    workspaceId,
    resourceId: existing.id,
    objectKind: "original",
    value: bytes,
    options: {
      httpMetadata: { contentType: input.mimeType },
      customMetadata: { source: "terminal", sourcePath: input.filePath },
    },
    at: timestamp,
  });
  let swapped: PublishedRow | null;
  try {
    swapped = await workspace.prepare(
      `UPDATE resources
          SET title = ?, mime_type = ?, content_ref = ?, content_sha256 = ?, metadata_json = ?,
              updated_at = ?,
              model_content_ref = NULL, model_mime_type = NULL, model_content_sha256 = NULL,
              model_metadata_json = NULL, model_content_status = ?,
              model_content_extractor_version = NULL, model_content_character_count = NULL,
              model_content_extracted_at = NULL, model_content_claimed_at = NULL,
              model_content_claim_id = NULL, model_content_error_code = NULL,
              revision_author_kind = 'agent', revision_author_run_id = ?,
              revision_author_user_id = NULL, revision_author_connection_id = NULL,
              revision_cause = 'published'
        WHERE id = ? AND workspace_id = ? AND content_ref IS ? AND content_sha256 IS ?
      RETURNING id, title, mime_type, content_ref, content_sha256, metadata_json,
                model_content_status, created_at`,
    ).bind(
      title,
      input.mimeType,
      objectRef,
      digest,
      metadata,
      timestamp,
      input.derivativeStatus,
      input.harnessRunId,
      existing.id,
      workspaceId,
      existing.content_ref,
      existing.content_sha256,
    ).first<PublishedRow>();
  } catch {
    // The insert path below converts its failures the same way; a raw D1 error
    // here would reach the model as the generic terminal_tool_failed with no
    // retry guidance, for the same operation.
    // A failed WorkspaceDO response is not evidence that its transaction
    // failed. Keep the staged bytes so a pointer that committed before the
    // response was lost can never name a deleted object.
    throw new TerminalToolError(
      "resource_publish_failed",
      "The published document could not be updated. Retry publish_resource with the stable final file.",
      { reason: "Retry the same publish_resource call so Rally can reconcile its resource identity." },
    );
  }
  // The row itself is the witness, not a write counter. `meta.changes` on a
  // WorkspaceDO-routed statement is workerd's physical `rowsWritten`, which this
  // UPDATE inflates through three version triggers — see
  // `docs/durable-object-sqlite.md`, which requires a returned witness here.
  if (swapped?.content_ref !== objectRef) {
    // Another publish of this document advanced the pointer first. Its content
    // is the current one; release this call's bytes to asynchronous cleanup and
    // report what the document now holds rather than clobbering the winner.
    await releaseStagedResourceObject(workspace, workspaceId, objectRef)
      .catch(() => undefined);
    const current = await workspace.prepare(
      `SELECT id, title, mime_type, content_ref, content_sha256, metadata_json,
              model_content_status, created_at
         FROM resources WHERE id = ? AND workspace_id = ?`,
    ).bind(existing.id, workspaceId).first<PublishedRow>();
    if (current) return current;
    throw new TerminalToolError(
      "resource_publish_failed",
      "The published document could not be updated. Retry publish_resource with the stable final file.",
      { reason: "Retry the same publish_resource call so Rally can reconcile its resource identity." },
    );
  }
  // `resources_track_original_after_update` already cancelled this object's
  // pending deletion inside the same statement and enqueued the superseded one,
  // which `resource_versions` then keeps alive. This delete is the belt for a
  // caller whose schema predates those triggers.
  await workspace.prepare(
    `DELETE FROM resource_object_deletion_outbox
      WHERE workspace_id = ? AND object_ref = ? AND cleanup_eligible = 0`,
  ).bind(workspaceId, objectRef).run().catch(() => undefined);
  return swapped;
}

export function createTerminalResourceBridge(
  env: Env,
  terminalPort: TerminalPortFactory,
  inObjectResourceAttacher?: WorkstreamRuntimeResourceAttacher,
): TerminalResourceBridge {
  // The layered runtime database routes resource rows to WorkspaceDO and
  // tool/link rows to SubstreamAgent. Keep every statement single-authority;
  // no query may join across those object-local databases.
  const workspace = env.DB;
  const attachResource = inObjectResourceAttacher
    ?? ((input) => attachWorkstreamRuntimeResource(env, input));
  return {
    async importResource(context, input, destinationPath, sandboxGeneration, providerSandboxId, provider) {
      const rows = await loadVisibleWorkstreamResourcesByIds(
        env.DB,
        createResourceObjectPort(env, context.workspaceId, context.workstreamId),
        {
          workspaceId: context.workspaceId,
          workstreamId: context.workstreamId,
          principal: context.executionPrincipal,
          resourceIds: [input.resourceId],
        },
      );
      const row = rows[0];
      if (!row) {
        throw new TerminalToolError(
          "resource_not_found",
          "That resource is no longer attached or visible to this run. Call workstream_list_resources to choose a currently visible resource, then retry import_resource.",
          { reason: "Call workstream_list_resources and choose a currently visible resource ID." },
        );
      }
      if (!row.content_ref) {
        throw new TerminalToolError(
          "resource_not_importable",
          "The resource has no stored bytes yet. Hydrate or download it with its connector tool, then retry import_resource.",
          { reason: "Hydrate or download the source with its connector tool, then retry the import." },
        );
      }
      const object = await env.PAYLOADS.get(row.content_ref);
      if (!object) {
        throw new TerminalToolError(
          "resource_not_importable",
          "The resource bytes are temporarily unavailable. Retry the import; if it persists, reattach the source resource.",
          { reason: "Retry once; if bytes remain unavailable, reattach the source resource." },
        );
      }
      const maximum = numericEnv(env, "MAX_ATTACHMENT_BYTES", 25_000_000);
      if (Number.isFinite(object.size) && object.size > maximum) {
        throw new TerminalToolError("resource_limit_exceeded", `The resource is ${object.size} bytes; Terminal imports allow at most ${maximum}. Publish or attach a smaller source file.`, { field: "resourceId", expected: `resource bytes at most ${maximum}` });
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.byteLength > maximum) {
        throw new TerminalToolError("resource_limit_exceeded", `The resource is ${bytes.byteLength} bytes; Terminal imports allow at most ${maximum}. Publish or attach a smaller source file.`, { field: "resourceId", expected: `resource bytes at most ${maximum}` });
      }
      const digest = await sha256Hex(bytes);
      if (row.content_sha256 && digest !== row.content_sha256) {
        throw new TerminalToolError(
          "resource_hash_mismatch",
          "The stored resource bytes changed while importing. Re-list the work-stream resources and retry from the current version.",
          { reason: "Re-list work-stream resources and retry the import from its current version." },
        );
      }
      const automatic = !("destinationPath" in input);
      // The runtime resolved this exact path inside /workspace, including
      // symlink containment. Never derive a sibling path from untrusted title
      // metadata after that check.
      const destination = destinationPath;
      const absolute = `/workspace/${destination}`;
      const existence = await provider.runUtilityCommand(providerSandboxId, {
        operation: "resource.import.inspect",
        command: [
          `target='${absolute.replace(/'/gu, `'"'"'`)}'`,
          'if [ ! -e "$target" ]; then exit 44; fi',
          'if [ -L "$target" ] || [ ! -f "$target" ]; then exit 45; fi',
          'size=$(stat -c %s -- "$target") || exit 46',
          'digest=$(sha256sum -- "$target" | cut -d " " -f 1) || exit 46',
          'printf "%s %s\\n" "$size" "$digest"',
        ].join("\n"),
        cwd: "/workspace",
        timeoutMs: 10_000,
      });
      if (existence.exitCode === 0) {
        if (automatic) {
          const existing = /^(\d+) ([0-9a-f]{64})\s*$/u.exec(existence.stdout);
          if (!existing || Number(existing[1]) !== bytes.byteLength || existing[2] !== digest) {
            throw new TerminalToolError(
              "destination_exists",
              "The deterministic import path already contains different bytes. Do not overwrite it; start a fresh Terminal workspace so Rally can re-establish resource provenance.",
              { reason: "Start a fresh Terminal workspace so Rally can re-establish automatic import provenance." },
            );
          }
          const timestamp = Date.now();
          await terminalPort(context.workspaceId, context.workstreamId)
            .recordImportedResource({
              sandboxGeneration,
              resourceId: row.id,
              destinationPath: destination,
              sourceSha256: digest,
              sizeBytes: bytes.byteLength,
              state: "completed",
              importedAt: timestamp,
              now: timestamp,
            });
          return {
            resourceId: row.id,
            filePath: destination,
            outcome: "reused",
            mimeType: row.mime_type ?? "application/octet-stream",
            sizeBytes: bytes.byteLength,
            sourceSha256: digest,
          };
        }
        if (!input.overwrite) {
          throw new TerminalToolError(
            "destination_exists",
            "The destination already exists. Choose another destinationPath or retry with overwrite: true after verifying that replacement is intended.",
            { reason: "Choose another destinationPath, or use overwrite: true only after confirming replacement." },
          );
        }
      }
      if (existence.exitCode !== 0 && existence.exitCode !== 44) {
        throw new TerminalToolError(
          "destination_not_regular",
          "The destination exists but is not a regular file Rally can safely replace. Choose a different destinationPath and retry.",
          { reason: "Choose a destinationPath that is absent or names a regular file beneath the Terminal workspace." },
        );
      }
      const plannedAt = Date.now();
      await terminalPort(context.workspaceId, context.workstreamId)
        .recordImportedResource({
          sandboxGeneration,
          resourceId: row.id,
          destinationPath: destination,
          sourceSha256: digest,
          sizeBytes: bytes.byteLength,
          state: "planned",
          importedAt: null,
          now: plannedAt,
        });
      const parent = absolute.slice(0, Math.max(absolute.lastIndexOf("/"), 1));
      const temporary = `/workspace/.rally/tmp/${newId()}`;
      await provider.writeFile(providerSandboxId, temporary, bytes, context.signal);
      let verified: Awaited<ReturnType<TerminalSandboxProvider["runUtilityCommand"]>>;
      try {
        verified = await provider.runUtilityCommand(providerSandboxId, {
          operation: "resource.import.finalize",
          command: [
            `target='${absolute.replace(/'/gu, `'"'"'`)}'`,
            `temporary='${temporary.replace(/'/gu, `'"'"'`)}'`,
            'trap \'rm -f -- "$temporary"\' EXIT',
            `mkdir -p -- '${parent.replace(/'/gu, `'"'"'`)}' || exit 46`,
            'mv -- "$temporary" "$target" || exit 46',
            "trap - EXIT",
            'printf "%s %s\\n" "$(stat -c %s -- "$target")" "$(sha256sum -- "$target" | cut -d " " -f 1)"',
          ].join("\n"),
          cwd: "/workspace",
          timeoutMs: 30_000,
        });
      } catch (error) {
        await provider.runUtilityCommand(providerSandboxId, {
          operation: "file.temp_cleanup",
          command: `rm -f -- '${temporary.replace(/'/gu, `'"'"'`)}'`,
          cwd: "/workspace",
          timeoutMs: 10_000,
        }).catch(() => undefined);
        throw error;
      }
      const observed = /^(\d+) ([0-9a-f]{64})\s*$/u.exec(verified.stdout);
      if (verified.exitCode !== 0 || !observed || Number(observed[1]) !== bytes.byteLength || observed[2] !== digest) {
        throw new TerminalToolError(
          "resource_import_failed",
          "Daytona did not confirm the imported bytes. Start a fresh Terminal workspace before retrying so unverified bytes cannot be reused.",
          { reason: "Start a fresh Terminal workspace before retrying the import." },
        );
      }
      const importedAt = Date.now();
      await terminalPort(context.workspaceId, context.workstreamId)
        .completeImportedResource({
          sandboxGeneration,
          resourceId: row.id,
          destinationPath: destination,
          sourceSha256: digest,
          importedAt,
          now: importedAt,
        });
      return {
        resourceId: row.id,
        filePath: destination,
        outcome: existence.exitCode === 0 ? "replaced" : "created",
        mimeType: row.mime_type ?? "application/octet-stream",
        sizeBytes: bytes.byteLength,
        sourceSha256: digest,
      };
    },

    async publishResource(context, input, bytes) {
      const maximum = numericEnv(env, "MAX_ATTACHMENT_BYTES", 25_000_000);
      if (bytes.byteLength > maximum) {
        throw new TerminalToolError("resource_limit_exceeded", `The file is ${bytes.byteLength} bytes; published resources allow at most ${maximum}. Reduce or split it and retry.`, { field: "filePath", expected: `file bytes at most ${maximum}` });
      }
      // A receipt is still required before anything is written: an unplanned
      // call has no attempt to be replaying, and refusing it here is what keeps
      // an unreceipted publish from reaching R2 at all.
      const effectIntentId = requireTerminalEffectIntent(context, "publication");
      // The published document's stable identity is the document's own
      // coordinates — this work stream and the path it was published from — so
      // revising the file and publishing it again lands on the row the first
      // publish created. Deriving it from the call instead made every identity
      // unique per call, which recognized a replay of that one call and nothing
      // else, so a second draft of the same file became a second document.
      const providerResourceId = input.providerResourceId
        ?? await publishedResourceIdentity(context.workstreamId, input.filePath);
      const select = `SELECT id, title, mime_type, content_ref, content_sha256, metadata_json,
                model_content_status, created_at
           FROM resources
          WHERE workspace_id = ? AND provider = 'avalon_generated' AND provider_resource_id = ?`;
      const existing = await workspace.prepare(select)
        .bind(context.workspaceId, providerResourceId).first<PublishedRow>();
      // Publications that settled under the per-call identity keep it. Their
      // attempt can still replay, and the path lookup above cannot see them, so
      // this second lookup is what stops a replay publishing a second copy of a
      // file this call already published.
      const settled = existing ?? await workspace.prepare(select)
        .bind(context.workspaceId, `terminal:${effectIntentId}`).first<PublishedRow>();

      const sourceName = fileName(input.filePath);
      const mimeType = verifyAttachmentMimeType(bytes, sourceName, null);
      const attachmentKind = classifyAttachmentKind({ mimeType, fileName: sourceName });
      const contentMode = attachmentKind === "image" ? "view" : attachmentKind === "audio" || attachmentKind === "other" ? "unsupported" : "read";
      const derivativeStatus = attachmentKind === "audio" || attachmentKind === "other" ? "unsupported" : "pending";
      const digest = await sha256Hex(bytes);

      if (settled) {
        const relink = async () => {
          const linked = await createResourceObjectPort(env, context.workspaceId, context.workstreamId)
            .isAttached({ resourceId: settled.id });
          if (linked) return;
          await attachResource({
            workspaceId: context.workspaceId,
            workstreamId: context.workstreamId,
            resourceId: settled.id,
            attachedByUserId: context.executionPrincipal.type === "user"
              ? context.executionPrincipal.userId
              : null,
          });
        };
        // Equal content covers both a crash-replay of a settled call and a
        // republish that changed nothing: the stored bytes are already these
        // bytes, so there is nothing to write. A row found only under the
        // per-call identity is a replay by definition and is never rewritten —
        // it keeps the identity it was published with.
        const perCallReplay = existing === null;
        if (perCallReplay || settled.content_sha256 === digest) {
          await relink();
          return publishedOutput(settled, bytes.byteLength);
        }
        const updated = await swapPublishedContent({
          workspace,
          env,
          workspaceId: context.workspaceId,
          existing: settled,
          filePath: input.filePath,
          displayName: input.displayName,
          description: input.description,
          bytes,
          digest,
          mimeType,
          attachmentKind,
          contentMode,
          derivativeStatus,
          harnessRunId: context.harnessRunId,
        });
        await relink();
        return publishedOutput(updated, bytes.byteLength);
      }

      const resourceId = newId();
      const timestamp = nowIso();
      const objectRef = `${env.AVALON_REGION}/${context.workspaceId}/resources/${resourceId}/terminal/${digest}/${newId()}`;
      await putStagedResourceObject({
        database: workspace,
        payloads: env.PAYLOADS,
        objectRef,
        workspaceId: context.workspaceId,
        resourceId,
        objectKind: "original",
        value: bytes,
        options: {
          httpMetadata: { contentType: mimeType },
          customMetadata: { source: "terminal", sourcePath: input.filePath },
        },
        at: timestamp,
      });
      const title = [...(input.displayName?.trim() || sourceName)].slice(0, 300).join("");
      const metadata = JSON.stringify({
        sourcePath: input.filePath,
        size: bytes.byteLength,
        attachmentKind,
        contentMode,
        ...(input.description ? { description: input.description } : {}),
      });
      try {
        await workspace.prepare(
            `INSERT INTO resources
             (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
              content_ref, content_sha256, metadata_json, last_hydrated_at, uploaded_by_user_id,
              attachment_status, model_content_status, created_at, updated_at,
              revision_author_kind, revision_author_run_id, revision_cause)
             VALUES (?, ?, 'generated_file', 'avalon_generated', ?, ?, ?, ?, ?, ?, ?, ?, 'attached', ?, ?, ?,
                     'agent', ?, 'created')`,
          ).bind(
            resourceId,
            context.workspaceId,
            providerResourceId,
            title,
            mimeType,
            objectRef,
            digest,
            metadata,
            timestamp,
            context.executionPrincipal.type === "user" ? context.executionPrincipal.userId : null,
            derivativeStatus,
            timestamp,
            timestamp,
            context.harnessRunId,
          ).run();
        await attachResource({
          workspaceId: context.workspaceId,
          workstreamId: context.workstreamId,
          resourceId,
          attachedByUserId: context.executionPrincipal.type === "user"
            ? context.executionPrincipal.userId
            : null,
        });
      } catch {
        // The resource insert may have committed before its response was lost.
        // Keep both the stable resource identity and staging fence intact so a
        // retry can observe and attach it without risking referenced bytes.
        throw new TerminalToolError(
          "resource_publish_failed",
          "The generated resource could not be recorded. Retry publish_resource; Rally retained cleanup ownership for the uploaded object.",
          { reason: "Retry the same publish_resource call so Rally can reconcile its stable resource identity." },
        );
      }
      // Failure to clear a staged row cannot make a published document fail:
      // maintenance will observe the active pointer and retire the row without
      // touching R2.
      await workspace.prepare(
        `DELETE FROM resource_object_deletion_outbox
          WHERE workspace_id = ? AND object_ref = ? AND cleanup_eligible = 0`,
      ).bind(context.workspaceId, objectRef).run().catch(() => undefined);
      // Outside the block that unwinds a failed publication: the document is
      // recorded and addressable by UUID now, and its alias is owed rather
      // than required — a reason to keep the row, never to drop it.
      await allocateResourceSlugBesideCreation(env, context.workspaceId, resourceId);
      return {
        resourceId,
        title,
        resourceType: "generated_file",
        provider: "avalon_generated",
        mimeType,
        sizeBytes: bytes.byteLength,
        sourceSha256: digest,
        attachmentKind,
        contentMode,
        derivativeStatus,
        createdAt: timestamp,
      };
    },
  };
}
