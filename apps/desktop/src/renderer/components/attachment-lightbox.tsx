import { classifyAttachmentKind } from '@rally/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { History, LoaderCircle, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AttachmentPreview } from './attachments';
import { MarkdownBody } from './workstream-blocks';

type PreviewMode = 'image' | 'markdown' | 'text';

interface LoadedPreview {
  preview: AttachmentPreview;
  src?: string;
  text?: string;
  error?: string;
}

function previewMode(preview: AttachmentPreview): PreviewMode {
  if (preview.src) return 'image';
  const mimeType = preview.mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mimeType.startsWith('text/') && mimeType !== 'text/markdown') return 'text';
  const kind = classifyAttachmentKind({ fileName: preview.name, mimeType: preview.mimeType });
  if (kind === 'image') return 'image';
  return kind === 'text' ? 'text' : 'markdown';
}

export function AttachmentLightbox({ preview, onClose }: {
  preview: AttachmentPreview | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const [loaded, setLoaded] = useState<LoadedPreview | null>(null);
  const mode = preview ? previewMode(preview) : null;

  useEffect(() => {
    if (!preview) return;
    const close = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', close);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', close);
    };
  }, [onClose, preview]);

  useEffect(() => {
    if (!preview || preview.src || !preview.loadContent || !mode) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void preview.loadContent(controller.signal).then(async (blob) => {
      if (mode === 'image') {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ preview, src: objectUrl });
        return;
      }
      const text = await blob.text();
      if (!controller.signal.aborted) setLoaded({ preview, text });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setLoaded({
        preview,
        error: error instanceof Error ? error.message : 'Rally could not load this attachment.',
      });
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [mode, preview]);

  if (!preview || !mode) return null;
  const current = loaded?.preview === preview ? loaded : null;
  const src = preview.src ?? current?.src;
  const loading = !src && current?.text === undefined && current?.error === undefined;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="attachment-lightbox-overlay" />
        <Dialog.Content
          aria-busy={loading || undefined}
          className="attachment-lightbox"
          onCloseAutoFocus={(event) => {
            if (!preview.returnFocus) return;
            event.preventDefault();
            preview.returnFocus.focus();
          }}
        >
          <header className="attachment-lightbox-header">
            {/* The label carries the notice, not just the name: the pill beside
                it is the only thing distinguishing history from the live
                document, and a screen reader hears none of it otherwise. */}
            <Dialog.Title asChild>
              <h2 aria-label={preview.superseded
                ? `Preview of ${preview.name} — ${preview.superseded.label}`
                : `Preview of ${preview.name}`}
              >
                {preview.name}
              </h2>
            </Dialog.Title>
            {preview.superseded && (
              <span className="attachment-lightbox-superseded" role="status">
                <History aria-hidden="true" size={14} /> {preview.superseded.label}
                <button onClick={preview.superseded.onReturnToCurrent} type="button">Return to current</button>
              </span>
            )}
            <Dialog.Close asChild>
              <button aria-label="Close preview" className="attachment-lightbox-close" type="button"><X size={20} /></button>
            </Dialog.Close>
          </header>
          <div className={`attachment-lightbox-content is-${mode}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
            {loading && <div className="attachment-lightbox-status" role="status"><LoaderCircle aria-hidden="true" className="spin" size={20} /> Preparing preview…</div>}
            {current?.error && <div className="attachment-lightbox-status is-error" role="alert">{current.error}</div>}
            {mode === 'image' && src && <img alt={preview.name} src={src} />}
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
