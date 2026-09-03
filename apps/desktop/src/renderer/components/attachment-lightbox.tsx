import { classifyAttachmentKind } from '@rally/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronLeft, ChevronRight, Download, History, LoaderCircle, Maximize2, Minimize2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AttachmentPreview } from './attachments';
import { MarkdownBody } from './workstream-blocks';

type PreviewMode = 'audio' | 'html' | 'image' | 'markdown' | 'text' | 'video';

interface LoadedPreview {
  preview: AttachmentPreview;
  src?: string;
  text?: string;
  error?: string;
}

const HTML_FILE_PATTERN = /\.html?$/iu;
const VIDEO_FILE_PATTERN = /\.(?:m4v|mov|mp4|ogv|webm)$/iu;

function previewMode(preview: AttachmentPreview): PreviewMode {
  const mimeType = preview.mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mimeType === 'text/html' || HTML_FILE_PATTERN.test(preview.name)) return 'html';
  if (mimeType.startsWith('video/') || VIDEO_FILE_PATTERN.test(preview.name)) return 'video';
  if (mimeType.startsWith('text/') && mimeType !== 'text/markdown') return 'text';
  const kind = classifyAttachmentKind({ fileName: preview.name, mimeType: preview.mimeType });
  if (kind === 'audio') return 'audio';
  if (preview.src || kind === 'image') return 'image';
  return kind === 'text' ? 'text' : 'markdown';
}

function isolatedHtml(source: string): string {
  const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; font-src data:; style-src \'unsafe-inline\';">';
  return source.match(/<head(?:\s[^>]*)?>/iu)
    ? source.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${policy}`)
    : `<!doctype html><html><head>${policy}</head><body>${source}</body></html>`;
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

export function AttachmentLightbox({ preview, onClose }: {
  preview: AttachmentPreview | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const gallery = useMemo(() => preview?.gallery?.length ? preview.gallery : preview ? [preview] : [], [preview]);
  const [activeIndex, setActiveIndex] = useState(0);
  const active = gallery[activeIndex] ?? preview;
  const [loaded, setLoaded] = useState<LoadedPreview | null>(null);
  const [expanded, setExpanded] = useState(false);
  const mode = active ? previewMode(active) : null;

  useEffect(() => {
    setActiveIndex(preview?.galleryIndex ?? 0);
  }, [preview]);

  useEffect(() => {
    setLoaded(null);
    setExpanded(false);
  }, [active]);

  useEffect(() => {
    if (!preview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (gallery.length > 1 && event.key === 'ArrowLeft') setActiveIndex((index) => (index - 1 + gallery.length) % gallery.length);
      if (gallery.length > 1 && event.key === 'ArrowRight') setActiveIndex((index) => (index + 1) % gallery.length);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [gallery.length, onClose, preview]);

  useEffect(() => {
    if (!active || active.src || !active.loadContent || !mode) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void active.loadContent(controller.signal).then(async (blob) => {
      if (mode === 'image' || mode === 'audio' || mode === 'video') {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ preview: active, src: objectUrl });
        return;
      }
      const text = await blob.text();
      if (!controller.signal.aborted) setLoaded({ preview: active, text });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setLoaded({
        preview: active,
        error: error instanceof Error ? error.message : 'Rally could not load this attachment.',
      });
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [active, mode]);

  if (!preview || !active || !mode) return null;
  const current = loaded?.preview === active ? loaded : null;
  const src = active.src ?? current?.src;
  const loading = !src && current?.text === undefined && current?.error === undefined;
  const isMedia = mode === 'image' || mode === 'video';

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="attachment-lightbox-overlay" />
        <Dialog.Content
          aria-busy={loading || undefined}
          className={`attachment-lightbox ${isMedia ? 'is-media-viewer' : 'is-document-viewer'}`}
          onCloseAutoFocus={(event) => {
            if (!preview.returnFocus) return;
            event.preventDefault();
            preview.returnFocus.focus();
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
              <button aria-label={`Download ${active.name}`} className="attachment-lightbox-action" onClick={() => void downloadPreview(active, src)} type="button"><Download size={18} /></button>
              <Dialog.Close asChild>
                <button aria-label="Close preview" className="attachment-lightbox-close" type="button"><X size={20} /></button>
              </Dialog.Close>
            </header>
          )}
          {isMedia && (
            <>
              <button
                aria-label={expanded ? 'Fit preview to window' : 'Show preview at full size'}
                className="attachment-media-expand"
                onClick={() => setExpanded((value) => !value)}
                type="button"
              >
                {expanded ? <Minimize2 size={19} /> : <Maximize2 size={19} />}
              </button>
              {gallery.length > 1 && (
                <>
                  <button aria-label="Previous attachment" className="attachment-gallery-arrow is-previous" onClick={() => setActiveIndex((index) => (index - 1 + gallery.length) % gallery.length)} type="button"><ChevronLeft size={25} /></button>
                  <button aria-label="Next attachment" className="attachment-gallery-arrow is-next" onClick={() => setActiveIndex((index) => (index + 1) % gallery.length)} type="button"><ChevronRight size={25} /></button>
                </>
              )}
            </>
          )}
          <div
            className={`attachment-lightbox-content is-${mode}${expanded ? ' is-expanded' : ''}`}
            onMouseDown={(event) => event.target === event.currentTarget && onClose()}
          >
            {loading && <div className="attachment-lightbox-status" role="status"><LoaderCircle aria-hidden="true" className="spin" size={20} /> Preparing preview…</div>}
            {current?.error && <div className="attachment-lightbox-status is-error" role="alert">{current.error}</div>}
            {mode === 'image' && src && <img alt={active.name} draggable={false} src={src} />}
            {mode === 'video' && src && <video aria-label={`Video: ${active.name}`} controls src={src} />}
            {mode === 'audio' && src && <audio aria-label={`Audio: ${active.name}`} controls src={src} />}
            {mode === 'html' && current?.text !== undefined && <iframe sandbox="" srcDoc={isolatedHtml(current.text)} title={`Preview of ${active.name}`} />}
            {mode === 'markdown' && current?.text !== undefined && (
              <article className="attachment-lightbox-document"><MarkdownBody verbatim>{current.text}</MarkdownBody></article>
            )}
            {mode === 'text' && current?.text !== undefined && <pre className="attachment-lightbox-text">{current.text}</pre>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
