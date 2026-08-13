import { classifyAttachmentKind } from '@avalon/contracts';
import { LoaderCircle, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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
  const kind = classifyAttachmentKind({ fileName: preview.name, mimeType: preview.mimeType });
  if (kind === 'image') return 'image';
  return kind === 'text' ? 'text' : 'markdown';
}

export function AttachmentLightbox({ preview, onClose }: {
  preview: AttachmentPreview | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const [loaded, setLoaded] = useState<LoadedPreview | null>(null);
  const label = useMemo(() => preview ? `Preview of ${preview.name}` : '', [preview]);
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
        error: error instanceof Error ? error.message : 'Avalon could not load this attachment.',
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
    <div aria-busy={loading || undefined} aria-label={label} aria-modal="true" className="attachment-lightbox" role="dialog">
      <header className="attachment-lightbox-header">
        <h2>{preview.name}</h2>
        <button autoFocus aria-label="Close preview" className="attachment-lightbox-close" onClick={onClose} type="button"><X size={20} /></button>
      </header>
      <div className={`attachment-lightbox-content is-${mode}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
        {loading && <div className="attachment-lightbox-status" role="status"><LoaderCircle aria-hidden="true" className="spin" size={20} /> Preparing preview…</div>}
        {current?.error && <div className="attachment-lightbox-status is-error" role="alert">{current.error}</div>}
        {mode === 'image' && src && <img alt={preview.name} src={src} />}
        {mode === 'markdown' && current?.text !== undefined && (
          <article className="attachment-lightbox-document"><MarkdownBody>{current.text}</MarkdownBody></article>
        )}
        {mode === 'text' && current?.text !== undefined && <pre className="attachment-lightbox-text">{current.text}</pre>}
      </div>
    </div>
  );
}
