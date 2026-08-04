import { useCallback, useEffect, useRef, useState } from 'react';
import type { AvalonApi } from './api';
import type { WorkstreamResource } from './types';

export type PendingAttachmentStatus = 'uploading' | 'ready' | 'failed';

export interface PendingAttachment {
  localId: string;
  file: File;
  previewUrl?: string;
  progress: number;
  status: PendingAttachmentStatus;
  resource?: WorkstreamResource;
  error?: string;
}

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25_000_000;
const IMAGE_FILE_PATTERN = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/iu;

const DELETE_RETRY_DELAYS_MS = [0, 250, 1_250] as const;

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

export function useFileAttachments(api: AvalonApi | null) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState<string>();
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const removed = useRef(new Set<string>());
  const apiRef = useRef(api);
  apiRef.current = api;

  const replace = useCallback((updater: (current: PendingAttachment[]) => PendingAttachment[]) => {
    const next = updater(attachmentsRef.current);
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  const upload = useCallback(async (attachment: PendingAttachment): Promise<void> => {
    if (!api) {
      replace((current) => current.map((item) => item.localId === attachment.localId
        ? { ...item, status: 'failed', error: 'Avalon is not connected. Try again after reconnecting.' }
        : item));
      return;
    }
    const controller = new AbortController();
    controllers.current.set(attachment.localId, controller);
    try {
      const resource = await api.uploadResource(
        attachment.file,
        attachment.localId,
        (progress) => replace((current) => current.map((item) => item.localId === attachment.localId ? { ...item, progress } : item)),
        controller.signal,
      );
      controllers.current.delete(attachment.localId);
      if (removed.current.has(attachment.localId)) {
        await deleteDraftWithRetry(api, resource.id).catch(() => undefined);
        return;
      }
      replace((current) => current.map((item) => item.localId === attachment.localId
        ? { ...item, progress: 100, resource, status: 'ready', error: undefined }
        : item));
    } catch (error) {
      controllers.current.delete(attachment.localId);
      if (error instanceof DOMException && error.name === 'AbortError') return;
      replace((current) => current.map((item) => item.localId === attachment.localId
        ? { ...item, status: 'failed', error: error instanceof Error ? error.message : 'Upload failed' }
        : item));
    }
  }, [api, replace]);

  const addFiles = useCallback((files: FileList | File[]): void => {
    const incoming = Array.from(files);
    const available = Math.max(0, MAX_ATTACHMENTS - attachmentsRef.current.length);
    const accepted = incoming.slice(0, available);
    setError(incoming.length > available ? `You can attach up to ${MAX_ATTACHMENTS} files to one message.` : undefined);
    const pending = accepted.map<PendingAttachment>((file) => ({
      localId: crypto.randomUUID(),
      file,
      ...(file.type.startsWith('image/') || IMAGE_FILE_PATTERN.test(file.name) ? { previewUrl: URL.createObjectURL(file) } : {}),
      progress: 0,
      status: file.size === 0 || file.size > MAX_ATTACHMENT_BYTES ? 'failed' : 'uploading',
      ...(file.size === 0
        ? { error: 'Empty files cannot be attached.' }
        : file.size > MAX_ATTACHMENT_BYTES
          ? { error: 'Files must be 25 MB or smaller.' }
          : {}),
    }));
    replace((current) => [...current, ...pending]);
    for (const attachment of pending) {
      if (attachment.status === 'uploading') void upload(attachment);
    }
  }, [replace, upload]);

  const removeAttachment = useCallback((localId: string): void => {
    const attachment = attachmentsRef.current.find((item) => item.localId === localId);
    if (!attachment) return;
    removed.current.add(localId);
    controllers.current.get(localId)?.abort();
    controllers.current.delete(localId);
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    replace((current) => current.filter((item) => item.localId !== localId));
    setError(undefined);
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
    void upload(retrying);
  }, [replace, upload]);

  const consume = useCallback((): void => {
    for (const attachment of attachmentsRef.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    attachmentsRef.current = [];
    setAttachments([]);
    setError(undefined);
  }, []);

  useEffect(() => () => {
    for (const controller of controllers.current.values()) controller.abort();
    for (const attachment of attachmentsRef.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      if (apiRef.current) {
        void deleteDraftWithRetry(apiRef.current, attachment.resource?.id ?? attachment.localId).catch(() => undefined);
      }
    }
  }, []);

  return {
    attachments,
    error,
    addFiles,
    removeAttachment,
    retryAttachment,
    consume,
    uploading: attachments.some((attachment) => attachment.status === 'uploading'),
    ready: attachments.filter((attachment) => attachment.status === 'ready' && attachment.resource),
  };
}
