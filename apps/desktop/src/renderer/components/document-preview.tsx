import { classifyAttachmentKind } from '@rally/contracts';
import { LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MarkdownBody } from './workstream-blocks';

/**
 * Reading a stored document's own bytes.
 *
 * One component, because two surfaces show the same thing and a second copy of
 * the mode decision would drift the way this repository's three markdown
 * renderers did: the attachment lightbox, which has shown attached documents
 * since before resources existed, and the inspector rail's resource detail,
 * which shows a cited resource. A citation that opened a metadata card would
 * be a dead end, and building the rail its own loader was the alternative this
 * extraction exists to refuse.
 *
 * It owns the load, not the frame. The lightbox is a dialog and the rail is a
 * panel; both hand this a name, a MIME type, and a way to fetch the bytes, and
 * neither has an opinion about how the other is laid out.
 */

export type DocumentPreviewMode = 'image' | 'markdown' | 'text';

export interface DocumentPreviewSource {
  name: string;
  mimeType?: string;
  /** An image already in hand — an uploaded file's object URL — needing no fetch. */
  src?: string;
  loadContent?: (signal?: AbortSignal) => Promise<Blob>;
}

/**
 * How a document should be shown, from its type rather than its extension alone.
 *
 * Markdown is the fallback rather than plain text: everything Rally publishes
 * as a document is markdown, and showing it rendered is the point.
 */
export function documentPreviewMode(source: DocumentPreviewSource): DocumentPreviewMode {
  if (source.src) return 'image';
  const mimeType = source.mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mimeType.startsWith('text/') && mimeType !== 'text/markdown') return 'text';
  const kind = classifyAttachmentKind({ fileName: source.name, mimeType: source.mimeType });
  if (kind === 'image') return 'image';
  return kind === 'text' ? 'text' : 'markdown';
}

interface LoadedDocument {
  source: DocumentPreviewSource;
  src?: string;
  text?: string;
  error?: string;
}

export interface DocumentPreviewState {
  mode: DocumentPreviewMode;
  loading: boolean;
  src?: string;
  text?: string;
  error?: string;
}

/**
 * Fetches a document's bytes and answers what to draw.
 *
 * The fetch is aborted and any object URL revoked when the source changes, so a
 * reader clicking through several resources in the rail never has two loads
 * racing to set the same pane.
 */
export function useDocumentPreview(source: DocumentPreviewSource | null): DocumentPreviewState | null {
  const [loaded, setLoaded] = useState<LoadedDocument | null>(null);
  const mode = source ? documentPreviewMode(source) : null;

  useEffect(() => {
    if (!source || source.src || !source.loadContent || !mode) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void source.loadContent(controller.signal).then(async (blob) => {
      if (mode === 'image') {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ source, src: objectUrl });
        return;
      }
      const text = await blob.text();
      if (!controller.signal.aborted) setLoaded({ source, text });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setLoaded({
        source,
        error: error instanceof Error ? error.message : 'Rally could not load this document.',
      });
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [mode, source]);

  if (!source || !mode) return null;
  const current = loaded?.source === source ? loaded : null;
  const src = source.src ?? current?.src;
  return {
    mode,
    loading: !src && current?.text === undefined && current?.error === undefined,
    ...(src === undefined ? {} : { src }),
    ...(current?.text === undefined ? {} : { text: current.text }),
    ...(current?.error === undefined ? {} : { error: current.error }),
  };
}

/**
 * The document itself: a status line while it loads or fails, then the content.
 *
 * Markdown renders `verbatim`, because a stored file's bytes are not a model's
 * words to repair — the same reason the lightbox has always passed that flag.
 */
export function DocumentPreviewContent({ name, state }: {
  name: string;
  state: DocumentPreviewState;
}): React.JSX.Element {
  return (
    <>
      {state.loading && (
        <div className="attachment-lightbox-status" role="status">
          <LoaderCircle aria-hidden="true" className="spin" size={20} /> Preparing preview…
        </div>
      )}
      {state.error && <div className="attachment-lightbox-status is-error" role="alert">{state.error}</div>}
      {state.mode === 'image' && state.src && <img alt={name} src={state.src} />}
      {state.mode === 'markdown' && state.text !== undefined && (
        <article className="attachment-lightbox-document"><MarkdownBody verbatim>{state.text}</MarkdownBody></article>
      )}
      {state.mode === 'text' && state.text !== undefined && <pre className="attachment-lightbox-text">{state.text}</pre>}
    </>
  );
}
