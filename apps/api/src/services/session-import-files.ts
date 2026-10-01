import type { PreparedConversation, SessionImportPreview } from '@rally/contracts';
import { workstreamImportHash } from '../durable-objects/workstream-import-hash';
import type { AuthContext, Env } from '../env';
import { stableUuid } from '../lib/stable-uuid';
import { ApiError } from '../lib/api-error';
import { ResourceService } from './resource-service';

/** Import bytes with upload semantics; artifacts are files, never fabricated executions. */
export async function prepareSessionImport(env: Env, auth: AuthContext, preview: SessionImportPreview, operationId: string,
  existingRevisions: ReadonlyMap<string, string> = new Map()): Promise<PreparedConversation> {
  const uploader = new ResourceService(env, auth);
  const person = await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(auth.userId).first<{ name: string }>();
  const provenance = { kind: 'imported_session', source: preview.source,
    importedByUserId: auth.userId, importedByName: person?.name || 'A workspace member' };
  const messages: PreparedConversation['messages'] = [];
  for (const [messageIndex, message] of preview.content.messages.entries()) {
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
      messages.push({ role: message.role, text: message.text || "Unchanged source attachment", attachmentIds: [], structuredContent: {
        ...provenance, sourceMessageId: message.sourceMessageId, sourceRevision,
      } });
      continue;
    }
    const attachmentIds: string[] = [];
    const missing: string[] = [];
    for (const [fileIndex, file] of (message.files ?? []).entries()) {
      if (file.source.kind !== 'inline') {
        missing.push(`Unavailable ${file.kind}: ${file.name} — ${file.source.kind === 'unavailable' ? file.source.reason : 'Read the conversation again to retrieve this file.'}`);
        continue;
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
        attachmentIds.push(id);
      } catch (error) {
        // Infrastructure failures must remain retryable; only a definite file
        // rejection becomes an unavailable reference in the committed history.
        if (error instanceof ApiError && ['attachment_encoding_invalid', 'attachment_empty', 'attachment_too_large', 'attachment_mime_mismatch', 'attachment_type_unsupported'].includes(error.code)) {
          missing.push(`Unavailable ${file.kind}: ${file.name} — ${error.message}`);
        } else throw error;
      }
    }
    messages.push({ role: message.role, text: [message.text, ...missing].filter(Boolean).join('\n\n'),
      attachmentIds, structuredContent: {
        ...provenance,
        ...(message.sourceMessageId ? { sourceMessageId: message.sourceMessageId,
          sourceRevision } : {}),
      } });
  }
  return { messages };
}
