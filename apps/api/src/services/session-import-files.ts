import type { PreparedConversation, SessionImportPreview } from '@rally/contracts';
import { workstreamImportHash } from '../durable-objects/workstream-import-hash';
import type { AuthContext, Env } from '../env';
import { stableUuid } from '../lib/stable-uuid';
import { settledBatches } from '../lib/settled-batches';
import { ApiError } from '../lib/api-error';
import { ResourceService } from './resource-service';

/**
 * LIMIT UNSET — open until the team chooses an upload width.
 * Bounds decoded attachment bytes and R2/DO upload work held concurrently.
 * Without it, caller-provided files all decode together beside their base64 request.
 * The existing per-file byte limit does not bound aggregate decoded memory.
 * Direction: upper bound; open value +Infinity. Started writes drain before failure.
 * Derive from: per-file bytes versus isolate memory, including the parsed request.
 */
export const MAX_SESSION_IMPORT_PARALLEL_UPLOADS = Number.POSITIVE_INFINITY;

/** Import bytes with upload semantics; artifacts are files, never fabricated executions. */
export async function prepareSessionImport(env: Env, auth: AuthContext, preview: SessionImportPreview, operationId: string,
  existingRevisions: ReadonlyMap<string, string> = new Map(),
  concurrency = MAX_SESSION_IMPORT_PARALLEL_UPLOADS): Promise<PreparedConversation> {
  const uploader = new ResourceService(env, auth);
  const person = await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(auth.userId).first<{ name: string }>();
  const provenance = { kind: 'imported_session', source: preview.source,
    importedByUserId: auth.userId, importedByName: person?.name || 'A workspace member' };
  const uploads: Array<() => Promise<void>> = [];
  const fileResults: Array<Array<{ id?: string; missing?: string }>> = [];
  const messages = preview.content.messages.map((message, messageIndex): PreparedConversation['messages'][number] => {
    const sourceRevision = message.sourceMessageId
      ? workstreamImportHash({ role: message.role, text: message.text, files: (message.files ?? []).map((file) => ({
        name: file.name, mimeType: file.mimeType, kind: file.kind,
        source: file.source.kind === 'inline' ? file.source
          : file.source.kind === 'remote' ? { kind: 'remote' }
            : { kind: 'unavailable', reference: /^https?:\/\//.test(file.source.reference) ? null : file.source.reference },
      })) }) : undefined;
    if (message.sourceMessageId && existingRevisions.get(message.sourceMessageId) === sourceRevision) {
      // The owner compares the complete source checkpoint again at commit time.
      // No old attachment needs another workspace upload for this snapshot.
      // Attachment-only messages need a nonempty transport placeholder; the
      // authority never materializes an unchanged entry.
      return { role: message.role, text: message.text || "Unchanged source attachment", attachmentIds: [], structuredContent: {
        ...provenance, sourceMessageId: message.sourceMessageId, sourceRevision,
      } };
    }
    const files: Array<{ id?: string; missing?: string }> = [];
    fileResults[messageIndex] = files;
    for (const [fileIndex, file] of (message.files ?? []).entries()) {
      uploads.push(async () => {
        files[fileIndex] = await (async () => {
          if (file.source.kind !== 'inline') {
            return { missing: `Unavailable ${file.kind}: ${file.name} — ${file.source.kind === 'unavailable' ? file.source.reason : 'Read the conversation again to retrieve this file.'}` };
          }
          const identity = { operationId, sourceRole: message.role, sourceKind: file.kind, fileIndex: `${messageIndex}:${fileIndex}` };
          const id = await stableUuid(['session-import-file', auth.workspaceId, auth.userId, operationId, String(messageIndex), String(fileIndex)]);
          try {
            let bytes: Uint8Array<ArrayBuffer>;
            try {
              bytes = file.source.encoding === 'utf8' ? new TextEncoder().encode(file.source.data)
                : Uint8Array.from(atob(file.source.data), (character) => character.charCodeAt(0));
            } catch {
              throw new ApiError(422, 'attachment_encoding_invalid', 'The export contains invalid encoded file bytes. Add the original file instead.');
            }
            await uploader.upload(new File([bytes], file.name, { type: file.mimeType }), file.name, id, identity);
            return { id };
          } catch (error) {
            // Infrastructure failures must remain retryable; only a definite file
            // rejection becomes an unavailable reference in the committed history.
            if (error instanceof ApiError && ['attachment_encoding_invalid', 'attachment_empty', 'attachment_too_large', 'attachment_mime_mismatch', 'attachment_type_unsupported'].includes(error.code)) {
              return { missing: `Unavailable ${file.kind}: ${file.name} — ${error.message}` };
            } else throw error;
          }
        })();
      });
    }
    return { role: message.role, text: message.text,
      attachmentIds: [], structuredContent: {
        ...provenance,
        ...(message.sourceMessageId ? { sourceMessageId: message.sourceMessageId,
          sourceRevision } : {}),
      } };
  });
  // One queue across all messages bounds decoding, not just individual message fan-out.
  // A failed batch drains its writes and never starts later batches. Successful
  // drafts retain stable identities for retry and the existing expiry cleanup.
  for await (const results of settledBatches(uploads, concurrency, upload => upload())) {
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  for (const [index, message] of messages.entries()) {
    const files = fileResults[index] ?? [];
    message.attachmentIds = files.flatMap(file => file.id ? [file.id] : []);
    message.text = [message.text, ...files.flatMap(file => file.missing ? [file.missing] : [])].filter(Boolean).join('\n\n');
  }
  return { messages };
}
