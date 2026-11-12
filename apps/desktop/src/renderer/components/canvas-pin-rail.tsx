import { IdentityTile } from '@rally/ui/components/identity-tile';
import { glyphInk } from '@rally/ui/lib/project-palette';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { IconPin, IconPinnedOff } from '@tabler/icons-react';
import clsx from 'clsx';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';

import { canvasRoute } from '../lib/canvases';
import { useCollaborationSession } from '../lib/collaboration-session';
import { useUiStore } from '../lib/ui-store';
import { canvasMark } from './canvas-mark';
import { useCanvasPinDrag } from './canvas-pin-drag';
import { usePinWrite } from './navigation-rows';
import { ErrorNotice, Tip } from './primitives';
import { RailItem } from './rail-item';

/** A second view of the Canvas list's pins, available from every section. */
export function CanvasPinRail(): React.JSX.Element {
  const { api } = useCollaborationSession();
  const { pinned, dragging, over, sourceProps, targetProps } = useCanvasPinDrag();
  const { error: pinError, setPinned } = usePinWrite(api ? (id, next) => api.setCanvasPinned(id, next) : undefined, 'Canvas');
  const open = matchPath('/canvases/:id', useLocation().pathname)?.params.id;
  const navigate = useNavigate();
  return <section aria-label="Pinned Canvas shortcuts" className={clsx('navigation-rail-pins', over === 'end' && 'navigation-pin-drop-end')} {...targetProps()}>
    <div className="navigation-rail-pins-list">
      {pinned.map((canvas) => {
        const { icon, color } = canvasMark(canvas.id, canvas.appearance);
        return <ContextMenu.Root key={canvas.id}>
          <ContextMenu.Trigger asChild>
            <span className={clsx('navigation-rail-pin', over === canvas.id && 'navigation-pin-drop-before')} {...targetProps(canvas.id)}>
              <Tip label={canvas.title}>
                <RailItem
                  active={open === canvas.id}
                  aria-current={open === canvas.id ? 'page' : undefined}
                  aria-label={canvas.unread ? `${canvas.title}, unread` : canvas.title}
                  badge={canvas.unread ? <span aria-label="Unread" className="navigation-row-unread-dot" role="img" /> : undefined}
                  icon={<IdentityTile icon={icon} ink={glyphInk(color)} shape="circle" size={34} tint={`var(--av-sys-color-project-${color})`} />}
                  label={canvas.title}
                  onClick={() => {
                    useUiStore.getState().setSidebarSection('canvases');
                    useUiStore.getState().setSidebarOpen(false);
                    void navigate(canvasRoute(canvas.id));
                  }}
                  {...sourceProps(canvas.id)}
                />
              </Tip>
            </span>
          </ContextMenu.Trigger>
          <ContextMenu.Portal><ContextMenu.Content className="menu-content">
            <ContextMenu.Item className="menu-item" onSelect={() => { void setPinned(canvas.id, false).catch(() => undefined); }}>
              <IconPinnedOff aria-hidden="true" size={15} stroke={1.8} />Unpin
            </ContextMenu.Item>
          </ContextMenu.Content></ContextMenu.Portal>
        </ContextMenu.Root>;
      })}
      {pinned.length === 0 && <Tip label="Drag a Canvas here to pin it">
        <span className={clsx('navigation-rail-pin-empty', dragging && 'is-armed')} role="img" aria-label="Drag a Canvas here to pin it">
          <IconPin aria-hidden="true" size={17} stroke={1.8} />
        </span>
      </Tip>}
      {pinError && <ErrorNotice occurrence={pinError}>The Canvas could not be unpinned. Try again.</ErrorNotice>}
    </div>
  </section>;
}
