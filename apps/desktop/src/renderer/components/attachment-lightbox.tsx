import { useAnnotationDraft } from './artifact-annotations';
import { AnnotationSurface } from './annotation-surface';
import { classifyAttachmentKind, isHtmlResource } from '@rally/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronLeft, ChevronRight, Download, History, Info, LoaderCircle, Maximize2, Minimize2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AttachmentPreview } from './attachments';
import { MarkdownBody } from './workstream-blocks';
import { attachmentMime, isVideoAttachment } from '../lib/attachment-media';
import { Tip } from './primitives';

type PreviewMode = 'audio' | 'html' | 'image' | 'markdown' | 'text' | 'video';

interface LoadedPreview {
  preview: AttachmentPreview;
  version?: number;
  src?: string;
  text?: string;
  error?: string;
}

/** Whether a file is an HTML page, which renders only inside {@link isolatedHtml}. */
export function isHtmlFile(file: { name: string; mimeType?: string | null | undefined }): boolean {
  return isHtmlResource({fileName:file.name,mimeType:file.mimeType});
}

function previewMode(preview: AttachmentPreview): PreviewMode {
  const mimeType = attachmentMime(preview.mimeType);
  if (isHtmlFile(preview)) return 'html';
  if (isVideoAttachment(mimeType, preview.name)) return 'video';
  if (mimeType.startsWith('text/') && mimeType !== 'text/markdown') return 'text';
  const kind = classifyAttachmentKind({ fileName: preview.name, mimeType: preview.mimeType });
  if (kind === 'audio') return 'audio';
  if (preview.src || kind === 'image') return 'image';
  return kind === 'text' ? 'text' : 'markdown';
}

export function isolatedHtml(source: string): string {
  const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; font-src data:; style-src \'unsafe-inline\';">';
  // Establish the policy before parsing any untrusted markup, including
  // resource tags before a head or a fake head inside a comment.
  return `<!doctype html><html><head>${policy}</head><body>${source}</body></html>`;
}

async function downloadPreview(preview: AttachmentPreview, loadedSource?: string): Promise<void> {
  let url = loadedSource;
  let shouldRevoke = false;
  if (!url && preview.loadContent) {
    url = URL.createObjectURL(await preview.loadContent());
    shouldRevoke = true;
  }
  if (!url) return;
  const anchor = document.createElement('a');
  anchor.download = preview.name;
  anchor.href = url;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  if (shouldRevoke) window.setTimeout(() => URL.revokeObjectURL(url!), 0);
}

function GalleryThumbnail({ preview, active, activeSrc, index, onSelect }: {
  preview: AttachmentPreview;
  active: boolean;
  activeSrc: string | undefined;
  index: number;
  onSelect: () => void;
}): React.JSX.Element {
  const src = preview.src ?? (active ? activeSrc : undefined);
  return <button aria-label={`View attachment ${index + 1}: ${preview.name}`} aria-current={active ? 'true' : undefined}
    className="attachment-gallery-thumbnail" onClick={onSelect} type="button">
    {src ? <img alt="" src={src} /> : <span>{index + 1}</span>}
  </button>;
}

/**
 * What one preview shows, shared by the lightbox and the conversation's right
 * panel: the gallery position, the loaded bytes for the active item, and how to
 * render them. Each host keeps only its own chrome.
 */
export function useAttachmentView(preview: AttachmentPreview | null) {
  const draft = useAnnotationDraft();
  const gallery = useMemo(() => preview?.gallery?.length ? preview.gallery : preview ? [preview] : [], [preview]);
  const [selection, setSelection] = useState({ preview, index: preview?.galleryIndex ?? 0 });
  if (selection.preview !== preview) {
    setSelection({ preview, index: preview?.galleryIndex ?? 0 });
  }
  const activeIndex = selection.preview === preview ? selection.index : preview?.galleryIndex ?? 0;
  const setActiveIndex = useCallback((update: (index: number) => number): void => {
    setSelection((current) => ({ ...current, index: update(current.index) }));
  }, []);
  const step = useCallback((delta: number): void => {
    setActiveIndex((index) => (index + delta + gallery.length) % gallery.length);
  }, [gallery.length, setActiveIndex]);
  const active = gallery[activeIndex] ?? preview;
  const preparedSource=useRef<string|undefined>(undefined);
  const preparedLoad=useRef<AbortController|null>(null);
  useEffect(()=>()=>{preparedLoad.current?.abort();if(preparedSource.current)URL.revokeObjectURL(preparedSource.current);preparedSource.current=undefined;},[active]);
  const [loaded, setLoaded] = useState<LoadedPreview | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const mode = active ? previewMode(active) : null;

  useEffect(() => {
    setLoaded(null);
    setDownloadError(null);
  }, [active]);

  useEffect(() => {
    if (!active || active.src || !active.loadContent || !mode) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    const version = active.version;
    void active.loadContent(controller.signal).then(async (blob) => {
      if (mode === 'image' || mode === 'audio' || mode === 'video') {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ preview: active, version, src: objectUrl });
        return;
      }
      const text = await blob.text();
      if (!controller.signal.aborted) setLoaded({ preview: active, version, text });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setLoaded({
        preview: active,
        version,
        error: error instanceof Error ? error.message : 'Rally could not load this attachment.',
      });
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [active, mode]);

  const prepareAnnotations = useCallback(async (): Promise<void> => {
    if (!active?.resourceId || active.version) return;
    if (!draft?.readResource || !draft.readResourceVersion) throw new Error('This preview cannot be commented on yet.');
    preparedLoad.current?.abort();
    const controller=new AbortController();preparedLoad.current=controller;
    const version = (await draft.readResource(active.resourceId)).currentVersion;
    controller.signal.throwIfAborted();
    const blob = await draft.readResourceVersion(active.resourceId,version,controller.signal);
    controller.signal.throwIfAborted();
    if (mode==='image') {
      if(preparedSource.current)URL.revokeObjectURL(preparedSource.current);
      const source = URL.createObjectURL(blob);preparedSource.current=source;
      setLoaded({preview:active,version,src:source});
    } else setLoaded({preview:active,version,text:await blob.text()});
  },[active,mode,draft?.readResource,draft?.readResourceVersion]);
  const current = active && loaded?.preview === active ? loaded : null;
  const src = current?.src ?? active?.src;
  const error = current?.error ?? (active && !src && !active.loadContent ? 'This resource has no preview available.' : undefined);
  const download = useCallback((): void => {
    if (!active) return;
    setDownloadError(null);
    void downloadPreview(active, src).catch(() => setDownloadError('Download failed. Please try again.'));
  }, [active, src]);
  return {
    version: active?.version ?? current?.version,
    prepareAnnotations,
    gallery,
    activeIndex,
    setActiveIndex,
    step,
    active,
    mode,
    src,
    text: current?.text,
    error,
    downloadError,
    download,
    loading: !src && current?.text === undefined && !error,
    isMedia: mode === 'image' || mode === 'video',
  };
}

export type AttachmentView = ReturnType<typeof useAttachmentView>;

/** The rendered content of the active preview, with its loading and error lines. */
export function AttachmentViewBody({ view }: { view: AttachmentView }): React.JSX.Element | null {
  const { active, mode, src, text, error, downloadError, loading } = view;
  if (!active || !mode) return null;
  if (active.resourceId && !loading && (!error || classifyAttachmentKind({fileName:active.name,mimeType:active.mimeType}) === 'other' || active.annotation) && mode !== 'audio' && mode !== 'video') {
    return <>{downloadError && <div role="alert">{downloadError}</div>}<AnnotationSurface className={mode==='markdown'?'attachment-lightbox-document':mode==='text'?'attachment-lightbox-text':undefined} resourceId={active.resourceId} version={active.annotation?.target.version ?? view.version ?? 0} name={active.name} mimeType={active.mimeType} sizeBytes={active.sizeBytes} text={text} src={src} saved={active.annotation} loadSavedImage={active.loadAnnotationImage} preparePicking={view.prepareAnnotations} /></>;
  }
  return <>
    {loading && <div className="attachment-lightbox-status" role="status"><LoaderCircle aria-hidden="true" className="spin" size={20} /> Preparing preview…</div>}
    {(error || downloadError) && <div className="attachment-lightbox-status is-error" role="alert">{error ?? downloadError}</div>}
    {mode === 'image' && src && <img alt={active.name} draggable={false} src={src} />}
    {mode === 'video' && src && <video aria-label={`Video: ${active.name}`} controls src={src} />}
    {mode === 'audio' && src && <audio aria-label={`Audio: ${active.name}`} controls src={src} />}
    {mode === 'html' && text !== undefined && <iframe sandbox="" srcDoc={isolatedHtml(text)} title={`Preview of ${active.name}`} />}
    {mode === 'markdown' && text !== undefined && (
      <article className="attachment-lightbox-document"><MarkdownBody verbatim>{text}</MarkdownBody></article>
    )}
    {mode === 'text' && text !== undefined && <pre className="attachment-lightbox-text">{text}</pre>}
  </>;
}

/** Thumbnails for a gallery of more than one item; nothing for a single one. */
export function AttachmentGalleryThumbnails({ view }: { view: AttachmentView }): React.JSX.Element | null {
  if (view.gallery.length < 2) return null;
  return <div className="attachment-gallery-thumbnails" aria-label="Attachment gallery">
    {view.gallery.map((item, index) => <GalleryThumbnail key={index} preview={item} index={index}
      active={index === view.activeIndex} activeSrc={view.src} onSelect={() => view.setActiveIndex(() => index)} />)}
  </div>;
}

export function AttachmentLightbox({ preview, onClose }: {
  preview: AttachmentPreview | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const view = useAttachmentView(preview);
  const { gallery, active, mode, src, error, step, isMedia } = view;
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [active]);

  useEffect(() => {
    if (!preview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('audio, video, input, textarea')) return;
      if (gallery.length > 1 && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) event.preventDefault();
      if (gallery.length > 1 && event.key === 'ArrowLeft') step(-1);
      if (gallery.length > 1 && event.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [gallery.length, preview, step]);

  if (!preview || !active || !mode) return null;
  const loading = view.loading;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="attachment-lightbox-overlay" />
        <Dialog.Content
          aria-busy={loading || undefined}
          className={`attachment-lightbox ${isMedia ? 'is-media-viewer' : 'is-document-viewer'}`}
          onCloseAutoFocus={(event) => {
            if (!preview.returnFocus?.isConnected) return;
            event.preventDefault();
            preview.returnFocus.focus();
          }}
          /*
            Keep the dialog's own focus rather than handing it to the first
            control. Every control in this chrome is an icon with a tooltip,
            and Radix opens a tooltip on focus: the preview would open with a
            tooltip nobody asked for, and that tooltip is then the topmost
            dismissable layer, so it, not the preview, is what the first
            Escape closes. `preventDefault` leaves focus on this element, which
            Radix gives `tabindex="-1"`, so the focus trap still has its entry
            point.
          */
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          <Dialog.Title className="attachment-lightbox-a11y-title">
            {preview.superseded ? `Preview of ${active.name} — ${preview.superseded.label}` : `Preview of ${active.name}`}
          </Dialog.Title>
          {!isMedia && (
            <header className="attachment-lightbox-header">
              <h2>{active.name}</h2>
              {preview.superseded && (
                <span className="attachment-lightbox-superseded" role="status">
                  <History aria-hidden="true" size={14} /> {preview.superseded.label}
                  <button onClick={preview.superseded.onReturnToCurrent} type="button">Return to current</button>
                </span>
              )}
              {active.onDetails && (
                <Tip label="Resource details">
                  <button aria-label="Resource details" className="attachment-lightbox-action" onClick={active.onDetails} type="button"><Info size={18} /></button>
                </Tip>
              )}
              {!error && (src || active.loadContent) && (
                <Tip label={`Download ${active.name}`}>
                  <button aria-label={`Download ${active.name}`} className="attachment-lightbox-action" onClick={view.download} type="button"><Download size={18} /></button>
                </Tip>
              )}
              <Tip label="Close preview">
                <Dialog.Close asChild>
                  <button aria-label="Close preview" className="attachment-lightbox-close" type="button"><X size={20} /></button>
                </Dialog.Close>
              </Tip>
            </header>
          )}
          {isMedia && (
            <>
              <Tip label="Download attachment">
                <button aria-label="Download attachment" className="attachment-media-download attachment-lightbox-action" onClick={view.download} type="button"><Download size={18} /></button>
              </Tip>
              <Tip label="Close preview">
                <Dialog.Close asChild><button aria-label="Close preview" className="attachment-media-close attachment-lightbox-action" type="button"><X size={20} /></button></Dialog.Close>
              </Tip>
              {active.onDetails && (
                <Tip label="Resource details">
                  <button aria-label="Resource details" className="attachment-media-details attachment-lightbox-action" onClick={active.onDetails} type="button"><Info size={18} /></button>
                </Tip>
              )}
              <Tip label={expanded ? 'Fit preview to window' : 'Show preview at full size'}>
                <button
                  aria-label={expanded ? 'Fit preview to window' : 'Show preview at full size'}
                  className="attachment-media-expand"
                  onClick={() => setExpanded((value) => !value)}
                  type="button"
                >
                  {expanded ? <Minimize2 size={19} /> : <Maximize2 size={19} />}
                </button>
              </Tip>
              {gallery.length > 1 && (
                <>
                  <Tip label="Previous attachment">
                    <button aria-label="Previous attachment" className="attachment-gallery-arrow is-previous" onClick={() => step(-1)} type="button"><ChevronLeft size={25} /></button>
                  </Tip>
                  <Tip label="Next attachment">
                    <button aria-label="Next attachment" className="attachment-gallery-arrow is-next" onClick={() => step(1)} type="button"><ChevronRight size={25} /></button>
                  </Tip>
                </>
              )}
            </>
          )}
          <div
            className={`attachment-lightbox-content is-${mode}${expanded ? ' is-expanded' : ''}${gallery.length > 1 ? ' has-gallery' : ''}`}
            onMouseDown={(event) => event.target === event.currentTarget && onClose()}
          >
            <AttachmentViewBody view={view} />
          </div>
          {isMedia && gallery.length > 1 && <footer className="attachment-gallery-footer">
            <span className="attachment-gallery-caption" aria-live="polite">{active.name} · {view.activeIndex + 1} / {gallery.length}</span>
            <AttachmentGalleryThumbnails view={view} />
          </footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
