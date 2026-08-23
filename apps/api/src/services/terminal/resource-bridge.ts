import { AttachmentKindSchema, classifyAttachmentKind } from "@avalon/contracts";
import { newId, nowIso } from "@avalon/db";

import type { Env } from "../../env";
import { numericEnv } from "../../env";
import { sha256Hex } from "../../lib/crypto";
import { verifyAttachmentMimeType } from "../attachment-mime-verification";
import {
  attachWorkstreamRuntimeResource,
  type WorkstreamRuntimeResourceAttacher,
} from "../workstream-object-client";
import { createResourceObjectPort } from "../../runtime/resource-port";
import { loadVisibleWorkstreamResourcesByIds } from "../workstream-resource-visibility";
import type { TerminalPortFactory } from "./object-port";
import type { TerminalResourceBridge } from "./runtime";
import { requireTerminalEffectIntent, TerminalToolError, type TerminalPublishedResourceOutput } from "./tools";

interface PublishedRow {
  id: string;
  title: string;
  mime_type: string | null;
  content_sha256: string | null;
  metadata_json: string;
  model_content_status: string | null;
  created_at: string;
}

function fileName(path: string): string {
  return path.split("/").at(-1) || "resource";
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
      "Avalon could not verify the previously published resource identity. Retry publish_resource with the stable final file.",
      { reason: "Retry the same publish_resource call so Avalon can reconcile its resource identity." },
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
      });
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
      const existence = await provider.runCommand(providerSandboxId, {
        taskName: `avalon-import-check-${row.id}`,
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
              "The deterministic import path already contains different bytes. Do not overwrite it; start a fresh Terminal workspace so Avalon can re-establish resource provenance.",
              { reason: "Start a fresh Terminal workspace so Avalon can re-establish automatic import provenance." },
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
          "The destination exists but is not a regular file Avalon can safely replace. Choose a different destinationPath and retry.",
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
      const mkdir = await provider.runCommand(providerSandboxId, {
        taskName: `avalon-import-dir-${row.id}`,
        command: `mkdir -p -- '${parent.replace(/'/gu, `'"'"'`)}'`,
        cwd: "/workspace",
        timeoutMs: 10_000,
      });
      if (mkdir.exitCode !== 0) {
        throw new TerminalToolError("resource_import_failed", "The destination directory could not be created. Choose another destinationPath and retry.", { reason: "Choose a writable destination beneath the Terminal workspace." });
      }
      await provider.writeFile(providerSandboxId, absolute, bytes, context.signal);
      const verified = await provider.runCommand(providerSandboxId, {
        taskName: `avalon-import-verify-${row.id}`,
        command: `target='${absolute.replace(/'/gu, `'"'"'`)}'; printf "%s %s\\n" "$(stat -c %s -- "$target")" "$(sha256sum -- "$target" | cut -d " " -f 1)"`,
        cwd: "/workspace",
        timeoutMs: 30_000,
      });
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
      // The published resource's stable identity across a resumed run. It is
      // the receipt the harness planned this call against, so a retry finds
      // the row it already wrote instead of publishing a second copy.
      const effectIntentId = requireTerminalEffectIntent(context, "publication");
      const providerResourceId = `terminal:${effectIntentId}`;
      const existing = await workspace.prepare(
        `SELECT id, title, mime_type, content_sha256, metadata_json,
                model_content_status, created_at
           FROM resources
          WHERE workspace_id = ? AND provider = 'avalon_generated' AND provider_resource_id = ?`,
      ).bind(context.workspaceId, providerResourceId).first<PublishedRow>();
      if (existing) {
        const linked = await createResourceObjectPort(env, context.workspaceId, context.workstreamId)
          .isAttached({ resourceId: existing.id });
        if (linked) return publishedOutput(existing, bytes.byteLength);
        await attachResource({
          workspaceId: context.workspaceId,
          workstreamId: context.workstreamId,
          resourceId: existing.id,
          attachedByUserId: context.executionPrincipal.type === "user"
            ? context.executionPrincipal.userId
            : null,
        });
        return publishedOutput(existing, bytes.byteLength);
      }

      const sourceName = fileName(input.filePath);
      const mimeType = verifyAttachmentMimeType(bytes, sourceName, null);
      const attachmentKind = classifyAttachmentKind({ mimeType, fileName: sourceName });
      const contentMode = attachmentKind === "image" ? "view" : attachmentKind === "other" ? "unsupported" : "read";
      const derivativeStatus = attachmentKind === "other" ? "unsupported" : "pending";
      const digest = await sha256Hex(bytes);
      const resourceId = newId();
      const timestamp = nowIso();
      const objectRef = `${env.AVALON_REGION}/${context.workspaceId}/resources/${resourceId}/terminal/${digest}/${newId()}`;
      await workspace.prepare(
        `INSERT OR IGNORE INTO resource_object_deletion_outbox
         (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
         VALUES (?, ?, ?, 'original', ?, ?)`,
      ).bind(objectRef, context.workspaceId, resourceId, timestamp, timestamp).run();
      await env.PAYLOADS.put(objectRef, bytes, {
        httpMetadata: { contentType: mimeType },
        customMetadata: { source: "terminal", sourcePath: input.filePath },
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
              attachment_status, model_content_status, created_at, updated_at)
             VALUES (?, ?, 'generated_file', 'avalon_generated', ?, ?, ?, ?, ?, ?, ?, ?, 'attached', ?, ?, ?)`,
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
          ).run();
        await attachResource({
          workspaceId: context.workspaceId,
          workstreamId: context.workstreamId,
          resourceId,
          attachedByUserId: context.executionPrincipal.type === "user"
            ? context.executionPrincipal.userId
            : null,
        });
        await workspace.prepare(
          "DELETE FROM resource_object_deletion_outbox WHERE workspace_id = ? AND object_ref = ?",
        ).bind(context.workspaceId, objectRef).run();
      } catch {
        await workspace.prepare(
          "DELETE FROM resources WHERE workspace_id = ? AND id = ?",
        ).bind(context.workspaceId, resourceId).run().catch(() => undefined);
        throw new TerminalToolError(
          "resource_publish_failed",
          "The generated resource could not be recorded. Retry publish_resource; Avalon retained cleanup ownership for the uploaded object.",
          { reason: "Retry the same publish_resource call so Avalon can reconcile its stable resource identity." },
        );
      }
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
