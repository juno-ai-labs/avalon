import type { ConversationFile, PreparedConversation, SessionImportPreview } from '@rally/contracts';
import type { AuthContext, Env } from '../env';
import { numericEnv } from '../env';
import { stableUuid } from '../lib/stable-uuid';
import { ApiError } from '../lib/api-error';
import { ResourceService } from './resource-service';

function unavailable(file: ConversationFile, reason: string): ConversationFile {
  return { ...file, source: { kind: 'unavailable', reference: file.source.kind === 'remote' ? file.source.url : file.name, reason } };
}

/** Recognized provider file origins only. Redirects never expand this authority. */
export function importFileUrlAllowed(value: string, provider: SessionImportPreview['source']['provider']): boolean {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return provider === 'chatgpt'
    ? (url.hostname === 'files.oaiusercontent.com' || url.hostname === 'cdn.openai.com') && url.pathname !== '/'
    : url.hostname === 'claude.ai' && /^\/api\/chat_snapshots\/[^/]+\/files\//.test(url.pathname);
}

/** Resolve transport in the preview, so the submitted content is stable across creation retries. */
export async function resolveSessionImportFiles(env: Env, preview: SessionImportPreview, fetcher: typeof fetch = fetch): Promise<SessionImportPreview> {
  const maximum = numericEnv(env, 'MAX_ATTACHMENT_BYTES', 25_000_000);
  const messages = [];
  for (const message of preview.content.messages) {
    const files: ConversationFile[] = [];
    for (const file of message.files ?? []) {
      if (file.source.kind !== 'remote') { files.push(file); continue; }
      if (!importFileUrlAllowed(file.source.url, preview.source.provider)) {
        files.push(unavailable(file, 'The source requires an authenticated or unsupported download. Add the original file instead.'));
        continue;
      }
      try {
        const response = await fetcher(file.source.url, { redirect: 'manual' });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          files.push(unavailable(file, 'The download is unavailable or requires login. Add the original file instead.'));
          continue;
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > maximum) throw new ApiError(413, 'attachment_too_large', 'The file exceeds the workspace attachment size limit.');
            chunks.push(next.value);
          }
        } finally { await reader.cancel(); }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        // Provider endpoints sometimes return a login/challenge document with 200.
        // Reject known transport pages, while allowing ordinary HTML artifacts.
        const document = new TextDecoder().decode(bytes);
        if (/\b(?:cf-chl-|_cf_chl_opt|challenge-platform\/)/i.test(document)
          || /<title[^>]*>\s*(?:Just a moment|Access denied|Log in to (?:ChatGPT|Claude)|Sign in to (?:ChatGPT|Claude))\b/i.test(document)) {
          files.push(unavailable(file, 'The download returned a login or challenge page. Add the original file instead.'));
          continue;
        }
        files.push({ ...file, source: { kind: 'inline', encoding: 'base64', data: btoa(binary) } });
      } catch (error) {
        files.push(unavailable(file, error instanceof ApiError ? error.message : 'The file could not be downloaded. Add the original file instead.'));
      }
    }
    messages.push({ ...message, ...(files.length ? { files } : {}) });
  }
  return { ...preview, content: { messages } };
}

/** Import bytes with upload semantics; artifacts are files, never fabricated executions. */
export async function prepareSessionImport(env: Env, auth: AuthContext, preview: SessionImportPreview, operationId: string): Promise<PreparedConversation> {
  const uploader = new ResourceService(env, auth);
  const person = await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(auth.userId).first<{ name: string }>();
  const provenance = { kind: 'imported_session', source: preview.source,
    importedByUserId: auth.userId, importedByName: person?.name || 'A workspace member' };
  const messages: PreparedConversation['messages'] = [];
  for (const [messageIndex, message] of preview.content.messages.entries()) {
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
      attachmentIds, structuredContent: provenance });
  }
  return { messages };
}
