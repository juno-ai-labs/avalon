import { DetailHeaderActionsHost } from './detail-header-actions';
import { useEffect, useState } from 'react';
import { ResourceIcon } from '@rally/ui/components/resource-icon';
import type { IconGroupAction } from '@rally/ui/components/icon-group';
import { ActionTile, ActionTiles, TitleMenuHeader, TitlePillClose, TitlePillHeader, type TitlePillLevel } from '@rally/ui/components/title-pill';
import { IconDownload, IconHistory, IconInfoCircle } from '@tabler/icons-react';
import { ChevronLeft, ChevronRight, History } from 'lucide-react';
import type { AttachmentPreview } from './attachments';
import { AttachmentGalleryThumbnails, AttachmentViewBody, useAttachmentView } from './attachment-lightbox';
import { IconButton } from './primitives';
import { RailSurface } from './rail-surface';

/**
 * An attachment, a file a citation names, or a prior version of a resource,
 * shown in the conversation's right panel.
 *
 * The same content the lightbox renders, in the slot an artifact uses, so a
 * person reads it beside the conversation, or expanded over it with the
 * stack's own Expand. The lightbox stays only for the surfaces that have no
 * panel of their own: search and the Channel composer.
 */
export function AttachmentPanel({ ancestors, expandAction, preview, leaving = false, onClose, onResize, onShow, width }: {
  preview: AttachmentPreview;
  /** The resource on screen, which a gallery changes as the reader steps through it. */
  onShow?: ((preview: AttachmentPreview, resourceId: string | null) => void) | undefined;
  leaving?: boolean;
  onClose: () => void;
  /** Expand the panel over its conversation, or put it back. */
  expandAction?: readonly IconGroupAction[] | undefined;
  /** What the panel sits in, as breadcrumbs, while it stands alone. */
  ancestors?: readonly TitlePillLevel[] | undefined;
  onResize: (width: number) => void;
  width: number;
}): React.JSX.Element | null {
  const [detailActions,setDetailActions] = useState<readonly IconGroupAction[]>([]);
  const view = useAttachmentView(preview);
  const { gallery, active, mode, src, error, step } = view;
  const shownId = active?.resourceId ?? null;
  useEffect(() => {
    onShow?.(preview, shownId);
  }, [onShow, preview, shownId]);
  if (!active || !mode) return null;
  const many = gallery.length > 1;
  const icon = <ResourceIcon resource={{ resourceType: 'uploaded_file', mimeType: active.mimeType ?? null, title: active.name }} />;
  return (
    <DetailHeaderActionsHost onActions={setDetailActions}><RailSurface
      className="attachment-panel"
      label={`Attachment: ${active.name}`}
      leaving={leaving}
      onClose={onClose}
      onKeyDown={(event) => {
        // Scoped to the panel, unlike the lightbox's window listener: the
        // composer beside it owns the arrow keys everywhere else.
        if (!many || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
        if (event.target instanceof HTMLElement && event.target.closest('audio, video, input, textarea, .image-viewport-scroll')) return;
        event.preventDefault();
        step(event.key === 'ArrowLeft' ? -1 : 1);
      }}
      onResize={onResize}
      resizeLabel="Resize attachment panel"
      width={width}
    >
      <TitlePillHeader
        className="panel-title-header"
        current={{
          key: 'attachment',
          icon,
          title: active.name,
          label: `Attachment menu: ${active.name}`,
          menu: <>
            <TitleMenuHeader eyebrow={preview.superseded ? preview.superseded.label : 'Attachment'} icon={icon} title={active.name} />
            <ActionTiles>
              <ActionTile disabled={Boolean(error) || !(src || active.loadContent)} icon={<IconDownload aria-hidden="true" size={20} stroke={1.6} />} label="Download" onSelect={view.download} />
              {active.onDetails && <ActionTile icon={<IconInfoCircle aria-hidden="true" size={20} stroke={1.6} />} label="Details" onSelect={active.onDetails} />}
              {preview.superseded && <ActionTile icon={<IconHistory aria-hidden="true" size={20} stroke={1.6} />} label="Current" onSelect={preview.superseded.onReturnToCurrent} />}
            </ActionTiles>
          </>,
        }}
        actions={[...detailActions,...(expandAction ?? [])].map((action) => ({...action, alwaysVisible:true}))}
        ancestors={ancestors ? [...ancestors] : []}
        trailing={<TitlePillClose label="Close panel" onClose={onClose} />}
      />
      <div
        aria-busy={view.loading || undefined}
        className={`attachment-panel-body is-${mode}${many ? ' has-gallery' : ''}`}
      >
        {preview.superseded && (
          <p className="attachment-lightbox-superseded attachment-panel-superseded" role="status">
            <History aria-hidden="true" size={14} /> {preview.superseded.label}
            <button onClick={preview.superseded.onReturnToCurrent} type="button">Return to current</button>
          </p>
        )}
        <div className="attachment-panel-content">
          <AttachmentViewBody view={view} />
        </div>
        {many && (
          <footer className="attachment-panel-gallery">
            <div className="attachment-panel-gallery-nav">
              <IconButton label="Previous attachment" onClick={() => step(-1)} tooltipSide="top"><ChevronLeft size={16} /></IconButton>
              <span aria-live="polite">{view.activeIndex + 1} / {gallery.length}</span>
              <IconButton label="Next attachment" onClick={() => step(1)} tooltipSide="top"><ChevronRight size={16} /></IconButton>
            </div>
            <AttachmentGalleryThumbnails view={view} />
          </footer>
        )}
      </div>
    </RailSurface></DetailHeaderActionsHost>
  );
}
