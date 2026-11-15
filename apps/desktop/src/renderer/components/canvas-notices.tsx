import { DEFAULT_NOTIFICATION_CHANNELS, type CanvasDetail, type CanvasNoticesRecord, type NotificationChannel } from '@rally/contracts';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconBell, IconBellOff } from '@tabler/icons-react';
import { Bell, Mail } from 'lucide-react';
import { MenuActionItem } from '@rally/ui/components/menu-action-item';
import { TitleMenuSeparator } from '@rally/ui/components/title-pill';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';

import { canvasDetailQueryKey } from '../lib/canvases';
import { useCollaborationSession } from '../lib/collaboration-session';
import { devicePushNotice, useDevicePushReadiness } from '../lib/device-push';
import { useMemberPreferences } from '../lib/use-member-preferences';
import { ChannelPicker, type ChannelOption } from './channel-picker';
import { Button, ErrorNotice } from './primitives';

/**
 * A Canvas's notices on the client (docs/PRDs/2026-11-14_canvas-notices):
 * the record its Chat shows when an agent turns them on, the title menu's
 * Notifications section, and the banner under its title that offers a member of an
 * Organization-wide Canvas to join it (a banner under its title). All three read the viewer's
 * `notices` on the Canvas detail and change it through the same two calls.
 */

/** Join the Canvas, or choose this viewer's channels for it; each answers the Canvas detail. */
function useCanvasNoticeActions(canvasId: string) {
  const { api } = useCollaborationSession();
  const queryClient = useQueryClient();
  const settle = (detail: CanvasDetail) => queryClient.setQueryData(canvasDetailQueryKey(canvasId), detail);
  const join = useMutation({ mutationFn: () => api!.joinCanvas(canvasId), onSuccess: settle });
  const choose = useMutation({
    mutationFn: (channels: NotificationChannel[] | null) => api!.setCanvasNoticeChoice(canvasId, channels),
    onSuccess: settle,
  });
  return { join, choose, error: join.error ?? choose.error };
}

/** How this viewer gets the Canvas's notices, in words. */
function channelsWords(channels: NotificationChannel[] | null): string {
  if (channels === null) return 'You get these as your Settings say for Canvas notices.';
  if (channels.length === 0) return 'You muted this Canvas.';
  if (channels.length === 2) return 'You get these by push, or by email when no device is set up.';
  return channels[0] === 'push' ? 'You get these by push.' : 'You get these by email.';
}

/** The device line: whether this device can show them, and the fix when it cannot. */
function DevicePushLine(): React.JSX.Element | null {
  const { api, host } = useCollaborationSession();
  const readiness = useDevicePushReadiness(api ?? null);
  // A device that cannot get push here at all has nothing to fix; the record says nothing about it.
  if (readiness.state === 'unavailable' || readiness.state === 'unconfigured') return null;
  const notice = devicePushNotice(host === 'desktop' ? 'mac' : 'browser', readiness.state);
  if (!notice) return null;
  return <div className="canvas-notices-device">
    <span className="canvas-notices-device-copy">
      <strong>{notice.title}</strong>
      {notice.detail && <small>{notice.detail}</small>}
    </span>
    {notice.action && <Button disabled={readiness.pending} onClick={() => void readiness.act()}>{notice.action.label}</Button>}
  </div>;
}

const CHANNEL_OPTIONS: ChannelOption[] = [
  { id: 'push', label: 'Push', hint: 'On every device signed in', icon: <Bell aria-hidden="true" size={14} /> },
  { id: 'email', label: 'Email', hint: 'To your account address', icon: <Mail aria-hidden="true" size={14} /> },
];

/**
 * The record a Canvas's Chat shows when its notices are turned on. Drawn for
 * everyone who can open the Canvas, with the viewer's own controls under the
 * newest one: join for someone not listed; for a participant, which channels
 * this Canvas uses, mute or turn back on; and the device line while they get
 * them by push.
 */
export function CanvasNoticesRecordCard({ record }: { record: CanvasNoticesRecord }): React.JSX.Element {
  const { api, session } = useCollaborationSession();
  const detail = useQuery({
    queryKey: canvasDetailQueryKey(record.canvasId),
    queryFn: ({ signal }) => api!.getCanvas(record.canvasId, signal),
    enabled: Boolean(api),
    staleTime: 5_000,
  });
  const queryClient = useQueryClient();
  const actions = useCanvasNoticeActions(record.canvasId);
  const notices = detail.data?.notices;
  // A record newer than the view this client holds means notices were turned
  // on or changed since it was read: read it once more. Both times are the
  // server's, and the registration commits right after the record lands.
  const stale = detail.isSuccess && (notices == null
    || (record.recordedAt !== undefined && notices.updatedAt !== undefined && record.recordedAt > notices.updatedAt));
  useEffect(() => {
    if (stale) void queryClient.invalidateQueries({ queryKey: canvasDetailQueryKey(record.canvasId) });
  }, [stale, queryClient, record.canvasId]);
  // Only the record that says what notices are about now carries controls; an older one is history.
  const current = notices?.purpose === record.purpose ? notices : null;
  // A guest is refused the members' preference routes and keeps the defaults.
  const settingsChannels = useMemberPreferences(session?.workspace?.accessClass === 'guest' ? null : api,
    session?.workspace?.id ?? 'unbound').data.notify.canvasNotices ?? DEFAULT_NOTIFICATION_CHANNELS.canvasNotices;
  const muted = current?.channels?.length === 0;
  const chosen = current?.channels ?? settingsChannels;
  const toggle = (channel: NotificationChannel) =>
    actions.choose.mutate(chosen.includes(channel) ? chosen.filter((candidate) => candidate !== channel) : [...chosen, channel]);
  const pushing = current?.participant && !muted && (current.channels === null || current.channels.includes('push'));
  return <section aria-label="Canvas notices" className="canvas-notices-record">
    <div className="canvas-notices-record-heading">
      <IconBell aria-hidden="true" size={16} stroke={1.8} />
      <strong>This Canvas sends notices.</strong>
    </div>
    <p className="canvas-notices-record-purpose">{record.purpose}</p>
    <p className="canvas-notices-record-by">Turned on by {record.registeredBy.name}.</p>
    {current && (current.participant
      ? <div className="canvas-notices-record-controls">
        <span>{channelsWords(current.channels)}</span>
        {muted
          ? <Button disabled={actions.choose.isPending} onClick={() => actions.choose.mutate(null)}>Turn on</Button>
          : <>
            <ChannelPicker disabled={actions.choose.isPending} label="How this Canvas tells you" none="Muted"
              onToggle={(channel) => toggle(channel as NotificationChannel)} options={CHANNEL_OPTIONS} selected={chosen} />
            {current.channels !== null
              && <Button disabled={actions.choose.isPending} onClick={() => actions.choose.mutate(null)}>Use Settings</Button>}
            <Button disabled={actions.choose.isPending} onClick={() => actions.choose.mutate([])}>Mute this Canvas</Button>
          </>}
      </div>
      // Only an Organization-wide Canvas can be joined; anyone else not listed is added by a manager.
      : <div className="canvas-notices-record-controls">
        <span>{detail.data?.visibility === 'workspace'
          ? 'You are not a participant, so these do not reach you.'
          : 'These reach the people this Canvas is shared with.'}</span>
        {detail.data?.visibility === 'workspace'
          && <Button disabled={actions.join.isPending} onClick={() => actions.join.mutate()}>Get notifications</Button>}
      </div>)}
    {pushing && <DevicePushLine />}
    {actions.error && <ErrorNotice occurrence={actions.error}>{actions.error.message}</ErrorNotice>}
  </section>;
}

/** The title menu's Notifications section; nothing while the Canvas's notices are off. */
export function CanvasNoticesMenuSection({ canvas }: { canvas: CanvasDetail | undefined }): React.JSX.Element | null {
  const labelId = useId();
  const actions = useCanvasNoticeActions(canvas?.id ?? '');
  const notices = canvas?.notices;
  if (!canvas || !notices) return null;
  const muted = notices.channels?.length === 0;
  // Only an Organization-wide Canvas can be joined.
  if (!notices.participant && canvas.visibility !== 'workspace') return null;
  return <>
    <TitleMenuSeparator />
    <DropdownMenu.Group aria-labelledby={labelId} className="canvas-notices-menu">
      <DropdownMenu.Label className="menu-label workspace-menu-section" id={labelId}>Notifications</DropdownMenu.Label>
      {!notices.participant
        ? <MenuActionItem className="menu-item title-menu-item title-menu-action" onSelect={() => actions.join.mutate()}>
          <IconBell aria-hidden="true" size={16} stroke={1.8} />
          <span className="title-menu-item-copy">Get notifications</span>
        </MenuActionItem>
        : muted
          ? <MenuActionItem className="menu-item title-menu-item title-menu-action" onSelect={() => actions.choose.mutate(null)}>
            <IconBell aria-hidden="true" size={16} stroke={1.8} />
            <span className="title-menu-item-copy">Turn on notifications</span>
          </MenuActionItem>
          : <MenuActionItem className="menu-item title-menu-item title-menu-action" onSelect={() => actions.choose.mutate([])}>
            <IconBellOff aria-hidden="true" size={16} stroke={1.8} />
            <span className="title-menu-item-copy">Mute notifications</span>
          </MenuActionItem>}
    </DropdownMenu.Group>
  </>;
}

const DISMISSED_KEY = 'rally.canvas-notices-banner-dismissed';

function dismissedCanvases(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * At the top of an Organization-wide Canvas with notices on, under its title,
 * for a viewer who is not a participant: join it to get its notices.
 * Dismissing it hides it for this Canvas on this device.
 */
export function CanvasNoticesJoinBanner({ canvas }: { canvas: CanvasDetail | undefined }): React.JSX.Element | null {
  // Decided before any hook, so a Canvas with nothing to offer mounts nothing:
  // the header renders this over states that hold no query client.
  if (!canvas || canvas.visibility !== 'workspace' || !canvas.notices || canvas.notices.participant) return null;
  return <JoinBanner canvas={canvas} purpose={canvas.notices.purpose} />;
}

function JoinBanner({ canvas, purpose }: { canvas: CanvasDetail; purpose: string }): React.JSX.Element | null {
  const actions = useCanvasNoticeActions(canvas.id);
  const [dismissed, setDismissed] = useState(() => dismissedCanvases());
  if (dismissed.includes(canvas.id)) return null;
  const dismiss = () => {
    const next = [...new Set([...dismissedCanvases(), canvas.id])];
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)); } catch { /* hidden for this view */ }
    setDismissed(next);
  };
  return <div aria-label="Canvas notices" className="canvas-notices-banner" role="region">
    <IconBell aria-hidden="true" size={16} stroke={1.8} />
    <span className="canvas-notices-banner-copy">This Canvas sends notices: {purpose}</span>
    <span className="canvas-notices-banner-actions">
      <Button disabled={actions.join.isPending} onClick={() => actions.join.mutate()}>Get notifications</Button>
      <Button onClick={dismiss}>Not now</Button>
    </span>
    {actions.error && <ErrorNotice occurrence={actions.error}>{actions.error.message}</ErrorNotice>}
  </div>;
}
