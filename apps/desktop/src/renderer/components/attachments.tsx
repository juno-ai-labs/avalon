import clsx from 'clsx';
import { File, RefreshCcw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PendingAttachment } from '../lib/use-file-attachments';
import type { MessageAttachment } from '../lib/types';

export interface AttachmentPreview {
  name: string;
  mimeType?: string;
  src?: string;
  loadContent?: (signal?: AbortSignal) => Promise<Blob>;
  returnFocus?: HTMLElement;
  /**
   * Set when what is being shown is a superseded version of a resource: the
   * notice, and the one action such a preview offers.
   *
   * A prior version renders in the same surface as the current one, so without
   * this nothing tells a reader which they are looking at — and reading a
   * stale draft as current is the failure this whole layer exists to make
   * impossible. The two travel together because a label with no way back, and
   * a way back with no label, are each half a feature.
   */
  superseded?: { label: string; onReturnToCurrent: () => void };
}

function extension(fileName: string): string {
  const value = fileName.split('.').at(-1)?.trim();
  return value && value !== fileName ? value.slice(0, 6).toLocaleLowerCase() : 'file';
}

function isImageAttachment(mimeType: string, fileName: string): boolean {
  return mimeType.startsWith('image/') || /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/iu.test(fileName);
}

function ProgressRing({ progress }: { progress: number }): React.JSX.Element {
  const radius = 17;
  const circumference = 2 * Math.PI * radius;
  return (
    <span className="attachment-progress" aria-label={`${progress}% uploaded`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
      <svg aria-hidden="true" viewBox="0 0 44 44">
        <circle className="attachment-progress-track" cx="22" cy="22" r={radius} />
        <circle className="attachment-progress-value" cx="22" cy="22" r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - progress / 100)} />
      </svg>
      <small>{progress}%</small>
    </span>
  );
}

export function PendingAttachmentTile({ actionsDisabled = false, attachment, onOpen, onRemove, onRetry }: {
  actionsDisabled?: boolean;
  attachment: PendingAttachment;
  onOpen: (preview: AttachmentPreview) => void;
  onRemove: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  const image = isImageAttachment(attachment.file.type, attachment.file.name) && attachment.previewUrl;
  return (
    <div className={clsx('attachment-tile', attachment.status === 'failed' && 'is-failed')} title={attachment.file.name}>
      <button
        aria-label={image ? `Preview ${attachment.file.name}` : attachment.file.name}
        className="attachment-tile-content"
        disabled={!image}
        onClick={(event) => image && onOpen({ name: attachment.file.name, src: attachment.previewUrl!, returnFocus: event.currentTarget })}
        type="button"
      >
        {image ? <img alt="" src={attachment.previewUrl} /> : <span className="attachment-extension">{extension(attachment.file.name)}</span>}
      </button>
      {attachment.status === 'uploading' && <ProgressRing progress={attachment.progress} />}
      {attachment.status === 'failed' && (
        <button aria-label={`Retry ${attachment.file.name}`} className="attachment-retry" disabled={actionsDisabled} onClick={onRetry} title={attachment.error} type="button"><RefreshCcw size={14} /></button>
      )}
      <button aria-label={`Remove ${attachment.file.name}`} className="attachment-remove" disabled={actionsDisabled} onClick={onRemove} type="button"><X size={13} /></button>
    </div>
  );
}

function RemoteAttachmentTile({ attachment, loadContent, onOpen }: {
  attachment: MessageAttachment;
  loadContent: (id: string, signal?: AbortSignal) => Promise<Blob>;
  onOpen: (preview: AttachmentPreview) => void;
}): React.JSX.Element {
  const isImage = isImageAttachment(attachment.mimeType, attachment.fileName);
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    if (!isImage || !attachment.contentAvailable) return;
    const controller = new AbortController();
    let url: string | undefined;
    void loadContent(attachment.id, controller.signal).then((blob) => {
      url = URL.createObjectURL(blob);
      setSrc(url);
    }).catch(() => undefined);
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachment.contentAvailable, attachment.id, isImage, loadContent]);
  return (
    <div className="attachment-tile sent-attachment" title={attachment.fileName}>
      <button
        aria-label={`Preview ${attachment.fileName}`}
        className="attachment-tile-content"
        disabled={!attachment.contentAvailable}
        onClick={(event) => onOpen({
          name: attachment.fileName,
          mimeType: attachment.mimeType,
          returnFocus: event.currentTarget,
          ...(src ? { src } : {}),
          loadContent: (signal) => loadContent(attachment.id, signal),
        })}
        type="button"
      >
        {src ? <img alt={attachment.fileName} src={src} /> : <span className="attachment-extension">{isImage ? <File size={18} /> : extension(attachment.fileName)}</span>}
      </button>
    </div>
  );
}

export function MessageAttachments({ attachments, loadContent, onOpen }: {
  attachments: MessageAttachment[];
  loadContent: (id: string, signal?: AbortSignal) => Promise<Blob>;
  onOpen: (preview: AttachmentPreview) => void;
}): React.JSX.Element | null {
  if (attachments.length === 0) return null;
  return <div className="message-attachments">{attachments.map((attachment) => <RemoteAttachmentTile attachment={attachment} key={attachment.id} loadContent={loadContent} onOpen={onOpen} />)}</div>;
}
