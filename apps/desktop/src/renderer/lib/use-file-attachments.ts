import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type RallyApi } from './api';
import {
  type CachedDraftAttachment,
  deleteDraftAttachments,
  draftCacheEpoch,
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
const DISCONNECTED_ERROR = 'Rally is not connected. Try again after reconnecting.';
const UNSAVED_ERROR = 'This device is out of room to hold attachments, so they will be lost if you quit before sending.';

const DELETE_RETRY_DELAYS_MS = [0, 250, 1_250] as const;

/** One shared empty list, so clearing an already-empty composer renders nothing. */
const NO_ATTACHMENTS: PendingAttachment[] = [];

/** The attachment draft owns only upload and draft cleanup operations. */
export type FileAttachmentsApi = Pick<RallyApi, 'deleteDraftResource' | 'uploadResource'>;

/** Expired drafts are swept once per application run, not once per composer. */
let prunedThisSession = false;
let pruning = false;

async function sha256Buffer(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function deleteDraftWithRetry(api: FileAttachmentsApi, id: string): Promise<void> {
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
    provider: 'rally_upload',
    mimeType: attachment.file.type || 'application/octet-stream',
    watchEnabled: false,
    watchStatus: 'unsupported',
    contentAvailable: true,
    sizeBytes: attachment.file.size,
    currentVersion: 1,
    relationshipType: 'attachment',
    direction: 'source',
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
 * cache under `draftKey`, so navigating away or restarting Rally leaves the
 * files exactly where the user left them. Sending or removing an attachment
 * clears its cached copy.
 */
export function useFileAttachments(api: FileAttachmentsApi | null, draftKey: string) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>(NO_ATTACHMENTS);
  const [error, setError] = useState<string>();
  const [fingerprinting, setFingerprinting] = useState(0);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const fingerprintQueue = useRef(Promise.resolve());
  const controllers = useRef(new Map<string, AbortController>());
  const removed = useRef(new Set<string>());
  const apiRef = useRef(api);
  apiRef.current = api;
  // Assigned during render, not in the effect below: a callback fired from the
  // render that changes `draftKey` must already attribute its work to the new
  // draft rather than to the one leaving the screen.
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
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
    const atEpoch = draftCacheEpoch();
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
      void updateDraftAttachment(key, attachment.localId, { resource }, atEpoch);
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
        void updateDraftAttachment(key, attachment.localId, { resource }, atEpoch);
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
    const atEpoch = draftCacheEpoch();
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
          }, atEpoch).then((stored) => {
            // Silence would be the wrong failure mode here: the attachment
            // still uploads and still sends, but it will not come back.
            if (!stored && draftKeyRef.current === key && draftCacheEpoch() === atEpoch) setError(UNSAVED_ERROR);
          });
        }
        if (attachment.status === 'uploading') void upload(attachment, key);
      }
    }).catch(() => {
      setError('Rally could not fingerprint the selected file. Try attaching it again.');
    }).finally(() => {
      setFingerprinting((current) => Math.max(0, current - 1));
    });
  }, [replace, upload]);

  /**
   * Forgets one attachment everywhere it exists: in flight, on screen, in the
   * cache, and upstream. `removed` also covers the upload that has not landed
   * yet, whose completion then deletes the draft it created.
   */
  const discard = useCallback((attachment: PendingAttachment, key: string): void => {
    removed.current.add(attachment.localId);
    controllers.current.get(attachment.localId)?.abort();
    controllers.current.delete(attachment.localId);
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    replace((current) => current.filter((item) => item.localId !== attachment.localId));
    void deleteDraftAttachments(key, [attachment.localId]);
    const client = apiRef.current;
    if (client) {
      void deleteDraftWithRetry(client, attachment.resource?.id ?? attachment.localId)
        .catch(() => undefined);
    }
  }, [replace]);

  const removeAttachment = useCallback((localId: string): void => {
    const attachment = attachmentsRef.current.find((item) => item.localId === localId);
    if (!attachment) return;
    discard(attachment, draftKeyRef.current);
    setError(undefined);
  }, [discard]);

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
    // Without a client the expired resources cannot be released, so the sweep
    // has not really happened: leave it un-run for a later composer to retry.
    if (prunedThisSession || pruning || !connected) return;
    pruning = true;
    void pruneExpiredDrafts().then((expired) => {
      const client = apiRef.current;
      if (!client) return;
      prunedThisSession = true;
      for (const attachment of expired) {
        void deleteDraftWithRetry(client, attachment.resource?.id ?? attachment.localId).catch(() => undefined);
      }
    }).finally(() => {
      pruning = false;
    });
  }, [connected]);

  useEffect(() => {
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
      let merged: PendingAttachment[] = [];
      replace((current) => {
        const present = new Set(current.map((item) => item.localId));
        merged = [...restored.filter((item) => !present.has(item.localId)), ...current];
        return merged;
      });
      for (const attachment of restored) {
        if (attachment.status === 'uploading') void upload(attachment, draftKey);
      }
      // A drop that raced the read was counted against an empty composer, so the
      // ten-file limit is settled here rather than by hiding the excess: the
      // overflow is cancelled, uncached, and its draft resources released.
      const overflowing = merged.slice(MAX_ATTACHMENTS);
      for (const attachment of overflowing) discard(attachment, draftKey);
      if (overflowing.length > 0) setError(`You can attach up to ${MAX_ATTACHMENTS} files to one message.`);
    });
    return () => {
      cancelled = true;
    };
  }, [connected, discard, draftKey, replace, upload]);

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
