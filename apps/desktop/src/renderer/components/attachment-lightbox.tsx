import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useEffect } from 'react';
import type { AttachmentPreview } from './attachments';
import { DocumentPreviewContent, useDocumentPreview } from './document-preview';

export function AttachmentLightbox({ preview, onClose }: {
  preview: AttachmentPreview | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const state = useDocumentPreview(preview);

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

  if (!preview || !state) return null;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="attachment-lightbox-overlay" />
        <Dialog.Content
          aria-busy={state.loading || undefined}
          className="attachment-lightbox"
          onCloseAutoFocus={(event) => {
            if (!preview.returnFocus) return;
            event.preventDefault();
            preview.returnFocus.focus();
          }}
        >
          <header className="attachment-lightbox-header">
            <Dialog.Title asChild><h2 aria-label={`Preview of ${preview.name}`}>{preview.name}</h2></Dialog.Title>
            <Dialog.Close asChild>
              <button aria-label="Close preview" className="attachment-lightbox-close" type="button"><X size={20} /></button>
            </Dialog.Close>
          </header>
          <div
            className={`attachment-lightbox-content is-${state.mode}`}
            onMouseDown={(event) => event.target === event.currentTarget && onClose()}
          >
            <DocumentPreviewContent name={preview.name} state={state} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
