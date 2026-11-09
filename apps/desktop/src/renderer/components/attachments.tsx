import { ErrorNotice } from './primitives';
import type { Annotation } from '@rally/contracts';
import { classifyAttachmentKind } from '@rally/contracts';
import clsx from 'clsx';
import { Download, File, FileText, Film, Music2, Pause, Play, RefreshCcw, Table2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PendingAttachment } from '../lib/use-file-attachments';
import type { MessageAttachment } from '../lib/types';
import { isImageAttachment, isVideoAttachment } from '../lib/attachment-media';
import { isPastedText } from '../lib/pasted-text';

export interface AttachmentPreview {
  annotation?: Annotation;
  loadAnnotationImage?: ((signal?: AbortSignal) => Promise<Blob>) | undefined;
  version?: number;
  name: string;
  /** The resource this previews, when it is one: what a pinned artifact's seen version is reported for. */
  resourceId?: string;
  sizeBytes?: number;
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
}

function splitFileName(fileName: string): { base: string; suffix: string } {
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === fileName.length - 1) return { base: fileName, suffix: '' };
  return { base: fileName.slice(0, lastDot), suffix: fileName.slice(lastDot) };
}

/** "28 B", "4.2 kB", "12 MB": a number and its unit are spaced, as SI writes them. */
function formatAttachmentSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} kB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

function pendingFileKind(mimeType: string, fileName: string): 'audio' | 'pdf' | 'markdown' | 'spreadsheet' | 'text' | 'generic' {
  const kind = classifyAttachmentKind({ mimeType, fileName });
  if (kind === 'audio' || kind === 'pdf') return kind;
  if (mimeType === 'text/markdown' || /\.(?:md|mdown|markdown)$/iu.test(fileName)) return 'markdown';
  if (mimeType === 'text/csv' || /\.(?:csv|numbers|ods|tsv|xls|xlsx)$/iu.test(fileName)) return 'spreadsheet';
  if (mimeType.startsWith('text/') || /\.(?:log|rtf|text|txt)$/iu.test(fileName)) return 'text';
  return 'generic';
}

function PendingFileIcon({ kind }: { kind: ReturnType<typeof pendingFileKind> }): React.JSX.Element {
  if (kind === 'audio') return <Music2 aria-hidden="true" size={19} />;
  if (kind === 'pdf') return <FileText aria-hidden="true" size={19} />;
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

function PreparingFileCard(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Preparing pasted text" className="attachment-file-card is-preparing" role="status">
      <span className="attachment-file-open">
        <span className="skeleton-bar attachment-file-icon" />
        <span className="attachment-file-details">
          <span className="skeleton-bar attachment-file-name-skeleton" />
          <span className="skeleton-bar attachment-file-meta-skeleton" />
        </span>
      </span>
    </div>
  );
}

export function PendingAttachmentTile({ actionsDisabled = false, attachment, onOpen, onRemove, onRetry }: {
  actionsDisabled?: boolean;
  attachment: PendingAttachment;
  onOpen: (preview: AttachmentPreview) => void;
  onRemove: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  const image = isImageAttachment(attachment.file.type, attachment.file.name);
  const video = isVideoAttachment(attachment.file.type, attachment.file.name);
  const media = image || video || pendingFileKind(attachment.file.type, attachment.file.name) === 'audio';
  const content = useMemo(() => async () => attachment.file, [attachment.file]);
  // A long paste has no name or type until the API returns one, so the card
  // holds its shape without claiming either.
  const preparing = attachment.status === 'uploading' && isPastedText(attachment.file);
  // Once uploaded, the resource is what the message will carry; for a long
  // paste the API chose its type and wrote its name from the text.
  const record: MessageAttachment = { id: attachment.localId, fileName: attachment.resource?.title ?? attachment.file.name,
    mimeType: attachment.resource?.mimeType ?? attachment.file.type, sizeBytes: attachment.file.size, contentAvailable: true, createdAt: '' };
  const preview: AttachmentPreview = { name: record.fileName, mimeType: record.mimeType,
    ...(attachment.previewUrl ? { src: attachment.previewUrl } : {}), loadContent: content };
  return (
    <div className={clsx('pending-attachment', media && 'attachment-tile', video && 'is-video', !media && 'is-file', attachment.status === 'failed' && 'is-failed')}>
      {image ? <RemoteImageAttachment image={{ attachment: record, src: attachment.previewUrl }}
        gallery={[preview]} index={0} onOpen={onOpen} />
        : media ? <AttachmentMediaTile name={record.fileName} mimeType={record.mimeType} src={attachment.previewUrl}
          loadContent={content} onOpen={(returnFocus) => onOpen({ ...preview, returnFocus })} />
        : preparing ? <PreparingFileCard />
        : <RemoteFileAttachment attachment={record} loadContent={content} onOpen={onOpen} showDownload={false} />}
      {attachment.status === 'uploading' && !preparing && <ProgressRing progress={attachment.progress} />}
      {attachment.status === 'failed' && <ErrorNotice>{record.fileName} couldn’t be uploaded. Try again.</ErrorNotice>}
      {attachment.status === 'failed' && (
        <button aria-label={`Retry ${record.fileName}`} className="attachment-retry" disabled={actionsDisabled} onClick={onRetry} title={attachment.error} type="button"><RefreshCcw size={14} /></button>
      )}
      <button aria-label={preparing ? 'Remove pasted text' : `Remove ${record.fileName}`} className="attachment-remove" disabled={actionsDisabled} onClick={onRemove} type="button"><X size={13} /></button>
    </div>
  );
}

/** All media stay visible; the parent grid owns wrapping and tile sizing. */
export function AttachmentImageGroup({ images, renderImage }: {
  images: readonly { key: string }[];
  renderImage: (index: number) => React.ReactNode;
}): React.JSX.Element {
  return <span className="message-attachment-images">{images.map((image, index) => (
    <span className="message-attachment-image-cell" key={image.key}>{renderImage(index)}</span>
  ))}</span>;
}

export function AttachmentMediaTile({ name, mimeType, loadContent, onOpen, disabled = false, src: suppliedSrc }: {
  name: string;
  mimeType?: string;
  src?: string;
  loadContent?: (signal?: AbortSignal) => Promise<Blob>;
  onOpen: (focus: HTMLElement) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const video = isVideoAttachment(mimeType ?? '', name);
  const src = suppliedSrc;
  return <span className="attachment-media-tile">
    <button aria-label={`Preview ${name}`} className="attachment-media-open" disabled={disabled} onClick={(event) => onOpen(event.currentTarget)} type="button">
      {video && src ? <video aria-hidden="true" muted playsInline preload="metadata" src={src} /> : video ? <Film aria-hidden="true" size={32} /> : <Music2 aria-hidden="true" size={32} />}
      <span className="attachment-media-name">{name}</span>
      {video && <span className="attachment-video-play"><Play aria-hidden="true" size={24} /></span>}
    </button>
    {!video && loadContent && !disabled && <AttachmentAudio name={name} loadContent={loadContent} />}
  </span>;
}

/** Fetch audio only after Play. A failed read is retryable and a removed card
 * cannot start playback after its pending download completes. */
export function AttachmentAudio({ name, loadContent }: {
  name: string;
  loadContent: (signal?: AbortSignal) => Promise<Blob>;
}): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [requested, setRequested] = useState(false);
  const [loaded, setLoaded] = useState<{ loader: typeof loadContent; src: string } | null>(null);
  const [error, setError] = useState(false);
  const src = loaded?.loader === loadContent ? loaded.src : undefined;
  useEffect(() => {
    if (!requested) return;
    const controller = new AbortController();
    let url: string | undefined;
    setError(false);
    void loadContent(controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setLoaded({ loader: loadContent, src: url });
    }).catch(() => {
      if (!controller.signal.aborted) { setError(true); setRequested(false); }
    });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [loadContent, requested]);
  return (
    <span className="attachment-inline-audio">
      {src ? <><audio ref={audioRef} aria-label={`Audio: ${name}`} autoPlay src={src} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
        <button aria-label={`${playing ? 'Pause' : 'Play'} ${name}`} onClick={() => {
          if (playing) audioRef.current?.pause();
          else void audioRef.current?.play().catch(() => setError(true));
        }} type="button">{playing ? <Pause size={16} /> : <Play size={16} />}{playing ? 'Pause' : 'Play'}</button></> : (
        <button aria-label={`Play ${name}`} disabled={requested} onClick={() => setRequested(true)} type="button">
          <Play aria-hidden="true" size={16} /> {requested ? 'Loading audio…' : 'Play audio'}
        </button>
      )}
      {error && <ErrorNotice>Audio unavailable. Try again.</ErrorNotice>}
    </span>
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
    resourceId: attachment.id,
    name: attachment.fileName,
    mimeType: attachment.mimeType,
    ...(src ? { src } : {}),
  };
  return (
    <button
      aria-label={`Preview ${attachment.fileName}`}
      className="message-attachment-image"
      title={attachment.fileName}
      disabled={!attachment.contentAvailable}
      onClick={(event) => onOpen({ ...preview, gallery, galleryIndex: index, returnFocus: event.currentTarget })}
      style={{
        aspectRatio: '1',
        width: '100%',
      }}
      type="button"
    >
      {src ? <img alt={attachment.fileName} src={src} /> : <span className="message-attachment-image-skeleton"><File aria-hidden="true" size={20} /></span>}
    </button>
  );
}

function RemoteFileAttachment({ attachment, loadContent, onOpen, showDownload = true }: {
  showDownload?: boolean;
  attachment: MessageAttachment;
  loadContent: (id: string, signal?: AbortSignal) => Promise<Blob>;
  onOpen: (preview: AttachmentPreview) => void;
}): React.JSX.Element {
  const name = splitFileName(attachment.fileName);
  const content = useMemo(() => (signal?: AbortSignal) => loadContent(attachment.id, signal), [attachment.id, loadContent]);
  const kind = pendingFileKind(attachment.mimeType, attachment.fileName);
  const preview: AttachmentPreview = { resourceId: attachment.id, sizeBytes:attachment.sizeBytes, name: attachment.fileName, mimeType: attachment.mimeType, loadContent: content };
  const [downloadError, setDownloadError] = useState(false);
  if (kind === 'audio' || isVideoAttachment(attachment.mimeType, attachment.fileName)) {
    return <AttachmentMediaTile name={attachment.fileName} mimeType={attachment.mimeType} loadContent={content}
      disabled={!attachment.contentAvailable} onOpen={(returnFocus) => onOpen({ ...preview, returnFocus })} />;
  }
  return (
    <div className="attachment-file-with-player">
    <div className="attachment-file-card" title={attachment.fileName}>
      <button
        aria-label={`Preview ${attachment.fileName}`}
        className="attachment-file-open"
        disabled={!attachment.contentAvailable}
        onClick={(event) => onOpen({ ...preview, returnFocus: event.currentTarget })}
        type="button"
      >
        <span className={clsx('attachment-file-icon', `is-${kind}`)}><PendingFileIcon kind={kind} /></span>
        <span className="attachment-file-details">
          <span className={clsx('attachment-file-name', attachment.fileName.length > 200 && 'is-long-name')}><span>{name.base}</span><span>{name.suffix}</span></span>
          <span className="attachment-file-meta">{formatAttachmentSize(attachment.sizeBytes)}</span>
        </span>
      </button>
      {showDownload && attachment.contentAvailable && (
        <button
          aria-label={`Download ${attachment.fileName}`}
          className="attachment-file-download"
          onClick={() => { setDownloadError(false); void downloadAttachment(attachment.fileName, content).catch(() => setDownloadError(true)); }}
          type="button"
        >
          <Download aria-hidden="true" size={19} />
        </button>
      )}
    </div>
    {downloadError && <ErrorNotice>Download failed. Please try again.</ErrorNotice>}
    </div>
  );
}

function useLoadedImages(attachments: MessageAttachment[], loadContent: (id: string, signal?: AbortSignal) => Promise<Blob>): LoadedImage[] {
  const [sources, setSources] = useState<Record<string, { src: string }>>({});
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
        setSources((current) => ({ ...current, [attachment.id]: { src } }));

      }).catch(() => undefined);
    }
    return () => {
      controller.abort();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [loadContent, stableAttachments]);
  return stableAttachments.map((attachment) => ({ attachment, src: sources[attachment.id]?.src }));
}

function RemoteImageGroup({ attachments, loadContent, onOpen }: {
  attachments: MessageAttachment[];
  loadContent: (id: string, signal?: AbortSignal) => Promise<Blob>;
  onOpen: (preview: AttachmentPreview) => void;
}): React.JSX.Element {
  const images = useLoadedImages(attachments, loadContent);
  const gallery = useMemo<AttachmentPreview[]>(() => images.map(({ attachment, src }) => ({
    resourceId:attachment.id,
    sizeBytes:attachment.sizeBytes,
    name: attachment.fileName,
    mimeType: attachment.mimeType,
    ...(src ? { src } : {}),
    loadContent: (signal) => loadContent(attachment.id, signal),
  })), [images, loadContent]);
  return <AttachmentImageGroup
    images={images.map((image) => ({ key: image.attachment.id }))}
    renderImage={(index) => <RemoteImageAttachment gallery={gallery} image={images[index]!} index={index} onOpen={onOpen} />}
  />;
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
