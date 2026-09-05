import clsx from 'clsx';
import { Download, File, FileText, Play, RefreshCcw, Table2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { PendingAttachment } from '../lib/use-file-attachments';
import type { MessageAttachment } from '../lib/types';
import { isImageAttachment, isVideoAttachment } from '../lib/attachment-media';

export interface AttachmentPreview {
  name: string;
  mimeType?: string;
  src?: string;
  loadContent?: (signal?: AbortSignal) => Promise<Blob>;
  returnFocus?: HTMLElement;
  /** Resource management remains available without reopening the shell rail. */
  onDetails?: () => void;
  gallery?: AttachmentPreview[];
  galleryIndex?: number;
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

interface LoadedImage {
  attachment: MessageAttachment;
  src?: string;
  aspectRatio: number;
}

function splitFileName(fileName: string): { base: string; suffix: string } {
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === fileName.length - 1) return { base: fileName, suffix: '' };
  return { base: fileName.slice(0, lastDot), suffix: fileName.slice(lastDot) };
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes}B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)}kB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)}MB`;
}

function pendingFileKind(mimeType: string, fileName: string): 'markdown' | 'spreadsheet' | 'text' | 'generic' {
  if (mimeType === 'text/markdown' || /\.(?:md|mdown|markdown)$/iu.test(fileName)) return 'markdown';
  if (mimeType === 'text/csv' || /\.(?:csv|numbers|ods|tsv|xls|xlsx)$/iu.test(fileName)) return 'spreadsheet';
  if (mimeType.startsWith('text/') || /\.(?:log|rtf|text|txt)$/iu.test(fileName)) return 'text';
  return 'generic';
}

function PendingFileIcon({ kind }: { kind: ReturnType<typeof pendingFileKind> }): React.JSX.Element {
  if (kind === 'markdown') return <span aria-hidden="true" className="attachment-markdown-glyph">M↧</span>;
  if (kind === 'spreadsheet') return <Table2 aria-hidden="true" size={19} />;
  if (kind === 'text') return <FileText aria-hidden="true" size={19} />;
  return <File aria-hidden="true" size={19} />;
}

async function downloadAttachment(name: string, loadContent: (signal?: AbortSignal) => Promise<Blob>): Promise<void> {
  const blob = await loadContent();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.download = name;
  anchor.href = url;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
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
  const video = isVideoAttachment(attachment.file.type, attachment.file.name) && attachment.previewUrl;
  const fileName = splitFileName(attachment.file.name);
  if (!image && !video) {
    const kind = pendingFileKind(attachment.file.type, attachment.file.name);
    return (
      <div className={clsx('attachment-file-card', 'is-pending', attachment.status === 'failed' && 'is-failed')} title={attachment.file.name}>
        <span className={clsx('attachment-file-icon', `is-${kind}`)}><PendingFileIcon kind={kind} /></span>
        <span className="attachment-file-details">
          <span className="attachment-file-name"><span>{fileName.base}</span><span>{fileName.suffix}</span></span>
          <span className="attachment-file-meta">{formatAttachmentSize(attachment.file.size)}</span>
        </span>
        {attachment.status === 'uploading' && <ProgressRing progress={attachment.progress} />}
        {attachment.status === 'failed' && (
          <button aria-label={`Retry ${attachment.file.name}`} className="attachment-retry" disabled={actionsDisabled} onClick={onRetry} title={attachment.error} type="button"><RefreshCcw size={14} /></button>
        )}
        <button aria-label={`Remove ${attachment.file.name}`} className="attachment-remove" disabled={actionsDisabled} onClick={onRemove} type="button"><X size={13} /></button>
      </div>
    );
  }
  return (
    <div className={clsx('attachment-tile', video && 'is-video', attachment.status === 'failed' && 'is-failed')} title={attachment.file.name}>
      <button
        aria-label={`Preview ${attachment.file.name}`}
        className="attachment-tile-content"
        onClick={(event) => onOpen({ name: attachment.file.name, mimeType: attachment.file.type, src: attachment.previewUrl!, returnFocus: event.currentTarget })}
        type="button"
      >
        {image
          ? <img alt="" src={attachment.previewUrl} />
          : <><video aria-hidden="true" muted playsInline preload="metadata" src={attachment.previewUrl} /><span className="attachment-video-play"><Play aria-hidden="true" fill="currentColor" size={18} /></span></>}
      </button>
      {attachment.status === 'uploading' && <ProgressRing progress={attachment.progress} />}
      {attachment.status === 'failed' && (
        <button aria-label={`Retry ${attachment.file.name}`} className="attachment-retry" disabled={actionsDisabled} onClick={onRetry} title={attachment.error} type="button"><RefreshCcw size={14} /></button>
      )}
      <button aria-label={`Remove ${attachment.file.name}`} className="attachment-remove" disabled={actionsDisabled} onClick={onRemove} type="button"><X size={13} /></button>
    </div>
  );
}

function RemoteImageAttachment({ image, gallery, index, onOpen }: {
  image: LoadedImage;
  gallery: AttachmentPreview[];
  index: number;
  onOpen: (preview: AttachmentPreview) => void;
}): React.JSX.Element {
  const { attachment, src } = image;
  const preview = gallery[index] ?? {
    name: attachment.fileName,
    mimeType: attachment.mimeType,
    ...(src ? { src } : {}),
  };
  return (
    <button
      aria-label={`Preview ${attachment.fileName}`}
      className="message-attachment-image"
      disabled={!attachment.contentAvailable}
      onClick={(event) => onOpen({ ...preview, gallery, galleryIndex: index, returnFocus: event.currentTarget })}
      style={{
        aspectRatio: String(image.aspectRatio),
        width: gallery.length === 1 ? Math.min(560, Math.max(64, image.aspectRatio * 200)) : undefined,
      }}
      type="button"
    >
      {src ? <img alt={attachment.fileName} src={src} /> : <span className="message-attachment-image-skeleton"><File aria-hidden="true" size={20} /></span>}
    </button>
  );
}

function RemoteFileAttachment({ attachment, loadContent, onOpen }: {
  attachment: MessageAttachment;
  loadContent: (id: string, signal?: AbortSignal) => Promise<Blob>;
  onOpen: (preview: AttachmentPreview) => void;
}): React.JSX.Element {
  const name = splitFileName(attachment.fileName);
  const preview: AttachmentPreview = {
    name: attachment.fileName,
    mimeType: attachment.mimeType,
    loadContent: (signal) => loadContent(attachment.id, signal),
  };
  return (
    <div className="attachment-file-card" title={attachment.fileName}>
      <button
        aria-label={`Preview ${attachment.fileName}`}
        className="attachment-file-open"
        disabled={!attachment.contentAvailable}
        onClick={(event) => onOpen({ ...preview, returnFocus: event.currentTarget })}
        type="button"
      >
        <span className="attachment-file-icon"><File aria-hidden="true" size={19} /></span>
        <span className="attachment-file-details">
          <span className="attachment-file-name"><span>{name.base}</span><span>{name.suffix}</span></span>
          <span className="attachment-file-meta">{formatAttachmentSize(attachment.sizeBytes)}</span>
        </span>
      </button>
      {attachment.contentAvailable && (
        <button
          aria-label={`Download ${attachment.fileName}`}
          className="attachment-file-download"
          onClick={() => void downloadAttachment(attachment.fileName, preview.loadContent!)}
          type="button"
        >
          <Download aria-hidden="true" size={19} />
        </button>
      )}
    </div>
  );
}

function useLoadedImages(attachments: MessageAttachment[], loadContent: (id: string, signal?: AbortSignal) => Promise<Blob>): LoadedImage[] {
  const [sources, setSources] = useState<Record<string, { src: string; aspectRatio: number }>>({});
  // `MessageAttachments` separates images from files with `filter`, so this
  // hook receives a freshly allocated array whenever its parent renders. The
  // attachment records themselves come from durable transcript data and have
  // not necessarily changed. Depending on the array by reference made the
  // effect clear its own `sources` state on every render; that clear caused the
  // next render, which restarted every download and alternated the feed between
  // a skeleton and a thumbnail indefinitely. Stabilize on the fields this
  // renderer reads so metadata-only transcript refreshes leave settled media
  // mounted, while any real attachment change still starts a new read.
  const attachmentsIdentity = JSON.stringify(attachments.map((attachment) => ({
    contentAvailable: attachment.contentAvailable,
    createdAt: attachment.createdAt,
    fileName: attachment.fileName,
    id: attachment.id,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  })));
  const stableAttachments = useMemo(() => attachments, [attachmentsIdentity]);
  useEffect(() => {
    const controller = new AbortController();
    const urls: string[] = [];
    setSources({});
    for (const attachment of stableAttachments) {
      if (!attachment.contentAvailable) continue;
      void loadContent(attachment.id, controller.signal).then((blob) => {
        if (controller.signal.aborted) return;
        const src = URL.createObjectURL(blob);
        urls.push(src);
        setSources((current) => ({ ...current, [attachment.id]: { src, aspectRatio: 4 / 3 } }));
        const probe = new Image();
        probe.onload = () => {
          if (controller.signal.aborted) return;
          const aspectRatio = probe.naturalWidth > 0 && probe.naturalHeight > 0 ? probe.naturalWidth / probe.naturalHeight : 4 / 3;
          setSources((current) => ({ ...current, [attachment.id]: { src, aspectRatio } }));
        };
        probe.src = src;
      }).catch(() => undefined);
    }
    return () => {
      controller.abort();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [loadContent, stableAttachments]);
  return stableAttachments.map((attachment) => ({ attachment, src: sources[attachment.id]?.src, aspectRatio: sources[attachment.id]?.aspectRatio ?? 4 / 3 }));
}

function RemoteImageGroup({ attachments, loadContent, onOpen }: {
  attachments: MessageAttachment[];
  loadContent: (id: string, signal?: AbortSignal) => Promise<Blob>;
  onOpen: (preview: AttachmentPreview) => void;
}): React.JSX.Element {
  const images = useLoadedImages(attachments, loadContent);
  const gallery = useMemo<AttachmentPreview[]>(() => images.map(({ attachment, src }) => ({
    name: attachment.fileName,
    mimeType: attachment.mimeType,
    ...(src ? { src } : {}),
    loadContent: (signal) => loadContent(attachment.id, signal),
  })), [images, loadContent]);
  const visible = images.slice(0, 3);
  return (
    <div className={clsx('message-attachment-images', images.length === 1 ? 'is-single' : 'is-gallery')}>
      {visible.map((image, index) => (
        <span className="message-attachment-image-cell" key={image.attachment.id} style={{ flexGrow: image.aspectRatio }}>
          <RemoteImageAttachment gallery={gallery} image={image} index={index} onOpen={onOpen} />
          {index === visible.length - 1 && images.length > visible.length && <span className="message-attachment-more" aria-hidden="true">+{images.length - visible.length}</span>}
        </span>
      ))}
    </div>
  );
}

export function MessageAttachments({ attachments, loadContent, onOpen }: {
  attachments: MessageAttachment[];
  loadContent: (id: string, signal?: AbortSignal) => Promise<Blob>;
  onOpen: (preview: AttachmentPreview) => void;
}): React.JSX.Element | null {
  if (attachments.length === 0) return null;
  const images = attachments.filter((attachment) => isImageAttachment(attachment.mimeType, attachment.fileName));
  const files = attachments.filter((attachment) => !isImageAttachment(attachment.mimeType, attachment.fileName));
  return (
    <div className="message-attachments">
      {images.length > 0 && <RemoteImageGroup attachments={images} loadContent={loadContent} onOpen={onOpen} />}
      {files.map((attachment) => <RemoteFileAttachment attachment={attachment} key={attachment.id} loadContent={loadContent} onOpen={onOpen} />)}
    </div>
  );
}
