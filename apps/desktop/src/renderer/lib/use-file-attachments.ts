import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type AvalonApi } from './api';
import {
  type CachedDraftAttachment,
  deleteDraftAttachments,
  nextDraftSortKey,
  pruneExpiredDrafts,
  readDraftAttachments,
  updateDraftAttachment,
  writeDraftAttachment,
} from './draft-cache';
import type { WorkstreamResource } from './types';

export type PendingAttachmentStatus = 'uploading' | 'ready' | 'failed';

export interface PendingAttachment {
  localId: string;
  file: File;
  sha256?: string;
  previewUrl?: string;
  progress: number;
  status: PendingAttachmentStatus;
  resource?: WorkstreamResource;
  error?: string;
}

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25_000_000;
const IMAGE_FILE_PATTERN = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/iu;
const DISCONNECTED_ERROR = 'Avalon is not connected. Try again after reconnecting.';

const DELETE_RETRY_DELAYS_MS = [0, 250, 1_250] as const;

/** One shared empty list, so clearing an already-empty composer renders nothing. */
const NO_ATTACHMENTS: PendingAttachment[] = [];

/** Expired drafts are swept once per application run, not once per composer. */
let prunedThisSession = false;

async function sha256Buffer(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function deleteDraftWithRetry(api: AvalonApi, id: string): Promise<void> {
  let lastError: unknown;
  for (const delay of DELETE_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    try {
      await api.deleteDraftResource(id);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  // The API's 24-hour draft reaper is the final backstop when a request was
  // accepted upstream after the renderer lost the upload connection.
  if (lastError) throw lastError;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_FILE_PATTERN.test(file.name);
}

/**
 * The upload endpoint keys a draft resource by the client's local ID, so a
 * conflict means an interrupted upload already landed upstream. The resource it
 * describes is the one this attachment would have created.
 */
function resourceFromLocalDraft(attachment: PendingAttachment): WorkstreamResource {
  return {
    id: attachment.localId,
    title: attachment.file.name,
    resourceType: 'uploaded_file',
    provider: 'avalon_upload',
    mimeType: attachment.file.type || 'application/octet-stream',
    watchEnabled: false,
    watchStatus: 'unsupported',
    contentAvailable: true,
    sizeBytes: attachment.file.size,
  };
}

function restoredAttachment(cached: CachedDraftAttachment, connected: boolean): PendingAttachment {
  const file = new File([cached.bytes], cached.fileName, { type: cached.mimeType, lastModified: cached.lastModified });
  return {
    localId: cached.localId,
    file,
    ...(cached.sha256 ? { sha256: cached.sha256 } : {}),
    ...(isImageFile(file) ? { previewUrl: URL.createObjectURL(file) } : {}),
    progress: cached.resource ? 100 : 0,
    ...(cached.resource
      ? { status: 'ready' as const, resource: cached.resource }
      : connected
        ? { status: 'uploading' as const }
        : { status: 'failed' as const, error: DISCONNECTED_ERROR }),
  };
}

/**
 * Owns the composer's pending attachments and mirrors them into the local draft
 * cache under `draftKey`, so navigating away or restarting Avalon leaves the
 * files exactly where the user left them. Sending or removing an attachment
 * clears its cached copy.
 */
export function useFileAttachments(api: AvalonApi | null, draftKey: string) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>(NO_ATTACHMENTS);
  const [error, setError] = useState<string>();
  const [fingerprinting, setFingerprinting] = useState(0);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const fingerprintQueue = useRef(Promise.resolve());
  const controllers = useRef(new Map<string, AbortController>());
  const removed = useRef(new Set<string>());
  const apiRef = useRef(api);
  apiRef.current = api;
  const draftKeyRef = useRef(draftKey);
  const connected = Boolean(api);

  const replace = useCallback((updater: (current: PendingAttachment[]) => PendingAttachment[]) => {
    const next = updater(attachmentsRef.current);
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  /** An upload that outlives its composer still updates the cache, never the UI. */
  const settle = useCallback((key: string, localId: string, patch: Partial<PendingAttachment>) => {
    if (draftKeyRef.current !== key) return;
    replace((current) => current.map((item) => item.localId === localId ? { ...item, ...patch } : item));
  }, [replace]);

  const upload = useCallback(async (attachment: PendingAttachment, key: string): Promise<void> => {
    const client = apiRef.current;
    if (!client) {
      settle(key, attachment.localId, { status: 'failed', error: DISCONNECTED_ERROR });
      return;
    }
    const controller = new AbortController();
    controllers.current.set(attachment.localId, controller);
    try {
      const resource = await client.uploadResource(
        attachment.file,
        attachment.localId,
        (progress) => settle(key, attachment.localId, { progress }),
        controller.signal,
      );
      controllers.current.delete(attachment.localId);
      if (removed.current.has(attachment.localId)) {
        await deleteDraftWithRetry(client, resource.id).catch(() => undefined);
        return;
      }
      // The cache write is bookkeeping; the composer is ready the moment the
      // upload is, and a lost write only costs a re-upload after a restart.
      void updateDraftAttachment(key, attachment.localId, { resource });
      settle(key, attachment.localId, { progress: 100, resource, status: 'ready', error: undefined });
    } catch (uploadError) {
      controllers.current.delete(attachment.localId);
      if (uploadError instanceof DOMException && uploadError.name === 'AbortError') return;
      if (uploadError instanceof ApiError && uploadError.code === 'attachment_draft_exists') {
        const resource = resourceFromLocalDraft(attachment);
        if (removed.current.has(attachment.localId)) {
          await deleteDraftWithRetry(client, resource.id).catch(() => undefined);
          return;
        }
        void updateDraftAttachment(key, attachment.localId, { resource });
        settle(key, attachment.localId, { progress: 100, resource, status: 'ready', error: undefined });
        return;
      }
      settle(key, attachment.localId, {
        status: 'failed',
        error: uploadError instanceof Error ? uploadError.message : 'Upload failed',
      });
    }
  }, [settle]);

  const addFiles = useCallback((files: FileList | File[]): void => {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    const key = draftKeyRef.current;
    setFingerprinting((current) => current + 1);
    fingerprintQueue.current = fingerprintQueue.current.then(async () => {
      const fingerprinted = await Promise.all(incoming.map(async (file) => {
        // Reading the bytes once serves both the duplicate check and the cache.
        if (file.size === 0 || file.size > MAX_ATTACHMENT_BYTES) return { file };
        const bytes = await file.arrayBuffer();
        return { file, bytes, sha256: await sha256Buffer(bytes) };
      }));
      const knownHashes = new Set(attachmentsRef.current.flatMap((attachment) => attachment.sha256 ? [attachment.sha256] : []));
      let duplicateCount = 0;
      const unique = fingerprinted.filter(({ sha256 }) => {
        if (!sha256 || !knownHashes.has(sha256)) {
          if (sha256) knownHashes.add(sha256);
          return true;
        }
        duplicateCount += 1;
        return false;
      });
      const available = Math.max(0, MAX_ATTACHMENTS - attachmentsRef.current.length);
      const accepted = unique.slice(0, available);
      const overflowCount = unique.length - accepted.length;
      const errors = [
        ...(duplicateCount > 0 ? [`Skipped ${duplicateCount} duplicate ${duplicateCount === 1 ? 'attachment' : 'attachments'}.`] : []),
        ...(overflowCount > 0 ? [`You can attach up to ${MAX_ATTACHMENTS} files to one message.`] : []),
      ];
      // A composer the user has since navigated away from still caches and
      // uploads what was dropped on it; only its visible state is off limits.
      const stillShowing = (): boolean => draftKeyRef.current === key;
      if (stillShowing()) setError(errors.length > 0 ? errors.join(' ') : undefined);
      const pending = accepted.map(({ file, bytes, sha256 }) => {
        const attachment: PendingAttachment = {
          localId: crypto.randomUUID(),
          file,
          ...(sha256 ? { sha256 } : {}),
          ...(isImageFile(file) ? { previewUrl: URL.createObjectURL(file) } : {}),
          progress: 0,
          status: file.size === 0 || file.size > MAX_ATTACHMENT_BYTES ? 'failed' : 'uploading',
          ...(file.size === 0
            ? { error: 'Empty files cannot be attached.' }
            : file.size > MAX_ATTACHMENT_BYTES
              ? { error: 'Files must be 25 MB or smaller.' }
              : {}),
        };
        return { attachment, bytes };
      });
      if (stillShowing()) replace((current) => [...current, ...pending.map(({ attachment }) => attachment)]);
      for (const { attachment, bytes } of pending) {
        // A file that can never be sent is not worth keeping on disk.
        if (bytes) {
          void writeDraftAttachment({
            draftKey: key,
            localId: attachment.localId,
            sortKey: nextDraftSortKey(),
            fileName: attachment.file.name,
            mimeType: attachment.file.type,
            lastModified: attachment.file.lastModified,
            bytes,
            ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
          });
        }
        if (attachment.status === 'uploading') void upload(attachment, key);
      }
    }).catch(() => {
      setError('Avalon could not fingerprint the selected file. Try attaching it again.');
    }).finally(() => {
      setFingerprinting((current) => Math.max(0, current - 1));
    });
  }, [replace, upload]);

  const removeAttachment = useCallback((localId: string): void => {
    const attachment = attachmentsRef.current.find((item) => item.localId === localId);
    if (!attachment) return;
    const key = draftKeyRef.current;
    removed.current.add(localId);
    controllers.current.get(localId)?.abort();
    controllers.current.delete(localId);
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    replace((current) => current.filter((item) => item.localId !== localId));
    setError(undefined);
    void deleteDraftAttachments(key, [localId]);
    if (api) {
      void deleteDraftWithRetry(api, attachment.resource?.id ?? localId)
        .catch(() => undefined);
    }
  }, [api, replace]);

  const retryAttachment = useCallback((localId: string): void => {
    const attachment = attachmentsRef.current.find((item) => item.localId === localId);
    if (!attachment || attachment.status !== 'failed' || attachment.file.size === 0 || attachment.file.size > MAX_ATTACHMENT_BYTES) return;
    const retrying = { ...attachment, progress: 0, status: 'uploading' as const, error: undefined };
    replace((current) => current.map((item) => item.localId === localId ? retrying : item));
    void upload(retrying, draftKeyRef.current);
  }, [replace, upload]);

  const consume = useCallback((localIds?: string[]): void => {
    const consumedIds = localIds ? new Set(localIds) : null;
    const consumed = consumedIds
      ? attachmentsRef.current.filter((attachment) => consumedIds.has(attachment.localId))
      : attachmentsRef.current;
    for (const attachment of consumed) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    const remaining = consumedIds
      ? attachmentsRef.current.filter((attachment) => !consumedIds.has(attachment.localId))
      : NO_ATTACHMENTS;
    attachmentsRef.current = remaining;
    setAttachments(remaining);
    setError(undefined);
    void deleteDraftAttachments(draftKeyRef.current, localIds);
  }, []);

  useEffect(() => {
    if (prunedThisSession) return;
    prunedThisSession = true;
    void pruneExpiredDrafts().then((expired) => {
      const client = apiRef.current;
      if (!client) return;
      for (const attachment of expired) {
        void deleteDraftWithRetry(client, attachment.resource?.id ?? attachment.localId).catch(() => undefined);
      }
    });
  }, []);

  useEffect(() => {
    draftKeyRef.current = draftKey;
    let cancelled = false;
    // In-flight uploads keep running: `upload` writes their result to the cache
    // under the key they started on, so nothing is lost by looking away.
    if (attachmentsRef.current.length > 0) {
      for (const attachment of attachmentsRef.current) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      replace(() => NO_ATTACHMENTS);
    }
    setError(undefined);
    void readDraftAttachments(draftKey).then((cached) => {
      if (cancelled) return;
      const overflow = cached.slice(MAX_ATTACHMENTS);
      if (overflow.length > 0) void deleteDraftAttachments(draftKey, overflow.map((item) => item.localId));
      if (cached.length === 0) return;
      const restored = cached.slice(0, MAX_ATTACHMENTS).map((item) => restoredAttachment(item, connected));
      // Files dropped while the cache was still opening keep their place at the
      // end of the row rather than being replaced by what was on disk.
      replace((current) => {
        const present = new Set(current.map((item) => item.localId));
        return [...restored.filter((item) => !present.has(item.localId)), ...current].slice(0, MAX_ATTACHMENTS);
      });
      for (const attachment of restored) {
        if (attachment.status === 'uploading') void upload(attachment, draftKey);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [connected, draftKey, replace, upload]);

  useEffect(() => () => {
    for (const controller of controllers.current.values()) controller.abort();
    for (const attachment of attachmentsRef.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
  }, []);

  return {
    attachments,
    error,
    addFiles,
    removeAttachment,
    retryAttachment,
    consume,
    uploading: fingerprinting > 0 || attachments.some((attachment) => attachment.status === 'uploading'),
    ready: attachments.filter((attachment) => attachment.status === 'ready' && attachment.resource),
  };
}
