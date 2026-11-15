import { DEFAULT_NOTIFICATION_CHANNELS, type CanvasDetail, type CanvasNoticesRecord, type CanvasNoticesView, type NotificationChannel } from '@rally/contracts';
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
import { useClientFeatureFlags } from '../lib/use-client-feature-flags';
import { useMemberPreferences } from '../lib/use-member-preferences';
import { ChannelPicker, type ChannelOption } from './channel-picker';
import { Button, ErrorNotice } from './primitives';

/**
 * A Canvas's notices on the client (docs/PRDs/2026-11-14_canvas-notices):
 * the record its Chat shows when an agent turns them on, the title menu's
 * Notifications section, and the banner under its title that offers a member
 * of an Organization-wide Canvas to join it. All three read the viewer's
 * `notices` on the Canvas detail and change it through the same two calls.
 */

/**
 * Join the Canvas, or choose this viewer's channels for it; each answers the
 * Canvas detail. `settingsChannels` is what Settings says for Canvas notices,
 * which a Canvas with no choice of its own follows. Choices run one at a
 * time per Canvas and show at once, so two quick changes cannot land out of
 * order or be computed from a stale list.
 */
function useCanvasNoticeActions(canvasId: string, onError?: (error: Error) => void) {
  const { api, session } = useCollaborationSession();
  const queryClient = useQueryClient();
  // A guest is refused the members' preference routes and keeps the defaults.
  const settingsChannels = useMemberPreferences(session?.workspace?.accessClass === 'guest' ? null : api,
    session?.workspace?.id ?? 'unbound').data.notify.canvasNotices ?? DEFAULT_NOTIFICATION_CHANNELS.canvasNotices;
  const key = canvasDetailQueryKey(canvasId);
  const settle = (detail: CanvasDetail) => queryClient.setQueryData(key, detail);
  const join = useMutation({ mutationFn: () => api!.joinCanvas(canvasId), onSuccess: settle, onError });
  const choose = useMutation({
    scope: { id: `canvas-notice-choice:${canvasId}` },
    mutationFn: (channels: NotificationChannel[] | null) => api!.setCanvasNoticeChoice(canvasId, channels),
    onMutate: async (channels) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<CanvasDetail>(key);
      if (previous?.notices) queryClient.setQueryData(key, { ...previous, notices: { ...previous.notices, channels } });
      return { previous };
    },
    onError: (error, _channels, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      onError?.(error);
    },
    onSuccess: settle,
  });
  // Back to Settings, unless Settings has these off too: then both channels, so turning on turns them on.
  const turnOn = () => choose.mutate(settingsChannels.length > 0 ? null : [...DEFAULT_NOTIFICATION_CHANNELS.canvasNotices]);
  /** The channels these notices go by for this viewer: their choice for this Canvas, else Settings. */
  const effective = (notices: CanvasNoticesView) => notices.channels ?? settingsChannels;
  return { join, choose, turnOn, effective, error: join.error ?? choose.error };
}

/** How this viewer gets the Canvas's notices, in words. */
function channelsWords(channels: readonly NotificationChannel[], fromSettings: boolean): string {
  if (channels.length === 0) return fromSettings ? 'Canvas notices are off in your Settings.' : 'You muted notices from this Canvas.';
  const how = channels.length === 2 ? 'by push, or by email when no device is set up'
    : channels[0] === 'push' ? 'by push' : 'by email';
  return `You get these ${how}${fromSettings ? ', as your Settings say' : ''}.`;
}

/** The device line: whether this device can show them, and the fix when it cannot. */
function DevicePushLine(): React.JSX.Element | null {
  const { api, host } = useCollaborationSession();
  const readiness = useDevicePushReadiness(api ?? null);
  const [failed, setFailed] = useState<Error | null>(null);
  // A device that cannot get push here at all has nothing to fix; the record says nothing about it.
  if (readiness.state === 'unavailable' || readiness.state === 'unconfigured') return null;
  const notice = devicePushNotice(host === 'desktop' ? 'mac' : 'browser', readiness.state);
  if (!notice) return null;
  const act = () => {
    setFailed(null);
    readiness.act().catch((cause: unknown) => setFailed(cause instanceof Error ? cause : new Error('Notifications could not be turned on.')));
  };
  return <div className="canvas-notices-device">
    <span className="canvas-notices-device-copy">
      <strong>{notice.title}</strong>
      {notice.detail && <small>{notice.detail}</small>}
    </span>
    {notice.action && <Button disabled={readiness.pending} onClick={act}>{notice.action.label}</Button>}
    {failed && <ErrorNotice occurrence={failed}>{failed.message}</ErrorNotice>}
  </div>;
}

const PUSH_OPTION: ChannelOption = { id: 'push', label: 'Push', hint: 'To a device you are signed in on', icon: <Bell aria-hidden="true" size={14} /> };
const EMAIL_OPTION: ChannelOption = { id: 'email', label: 'Email', hint: 'To your account address', icon: <Mail aria-hidden="true" size={14} /> };

/**
 * The record a Canvas's Chat shows when its notices are turned on. Drawn for
 * everyone who can open the Canvas, with the viewer's own controls under the
 * newest one: join for someone not listed; for a participant, which channels
 * this Canvas uses, mute or turn back on; and the device line while they get
 * them by push.
 */
export function CanvasNoticesRecordCard({ record }: { record: CanvasNoticesRecord }): React.JSX.Element {
  const { api } = useCollaborationSession();
  // The Canvas screen keeps this fresh; a record scrolling back into view does not read it again.
  const detail = useQuery({
    queryKey: canvasDetailQueryKey(record.canvasId),
    queryFn: ({ signal }) => api!.getCanvas(record.canvasId, signal),
    enabled: Boolean(api),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const pushAvailable = useClientFeatureFlags(api).data?.pushNotificationsEnabled === true;
  const queryClient = useQueryClient();
  const actions = useCanvasNoticeActions(record.canvasId);
  const notices = detail.data?.notices;
  // A record newer than the view this client holds means notices were turned
  // on or changed since it was read: read it once more. Both times are the
  // server's, and the record reaches open screens only after it is saved.
  const stale = detail.isSuccess && (notices == null || record.recordedAt > notices.updatedAt);
  useEffect(() => {
    if (stale) void queryClient.invalidateQueries({ queryKey: canvasDetailQueryKey(record.canvasId) });
  }, [stale, queryClient, record.canvasId]);
  // Only the record that says what notices are about now carries controls; an older one is history.
  const current = notices?.purpose === record.purpose ? notices : null;
  const history = detail.isSuccess && notices != null && current === null;
  const channels = current ? actions.effective(current) : [];
  const off = channels.length === 0;
  const followsSettings = current?.channels === null;
  // The device line shows only where these go by push.
  const pushing = current?.participant === true && channels.includes('push');
  // Push is offered where this deployment can push; a stored push stays in the list.
  const options = pushAvailable || channels.includes('push') ? [PUSH_OPTION, EMAIL_OPTION] : [EMAIL_OPTION];
  const toggle = (channel: NotificationChannel) =>
    actions.choose.mutate(channels.includes(channel) ? channels.filter((candidate) => candidate !== channel) : [...channels, channel]);
  const pending = actions.choose.isPending;
  return <section aria-label={history ? 'Earlier Canvas notices' : 'Canvas notices'}
    className={history ? 'canvas-notices-record is-history' : 'canvas-notices-record'}>
    <div className="canvas-notices-record-heading">
      <IconBell aria-hidden="true" size={16} stroke={1.8} />
      <strong>{history ? 'This Canvas used to send notices for:' : 'This Canvas sends notices.'}</strong>
    </div>
    <p className="canvas-notices-record-purpose">{record.purpose}</p>
    <p className="canvas-notices-record-by">Turned on by {record.registeredBy.name}.</p>
    {current && (current.participant
      ? <div className="canvas-notices-record-controls">
        <span aria-live="polite">{channelsWords(channels, followsSettings)}</span>
        <div className="canvas-notices-record-actions">
          {off
            ? <Button disabled={pending} onClick={actions.turnOn}>Turn on notifications</Button>
            : <>
              <ChannelPicker disabled={pending} label="How this Canvas tells you" none="Off"
                onToggle={(channel) => toggle(channel as NotificationChannel)} options={options} selected={channels} />
              {!followsSettings && <Button disabled={pending} onClick={() => actions.choose.mutate(null)}>Use my Settings</Button>}
              <Button disabled={pending} onClick={() => actions.choose.mutate([])}>Mute notifications</Button>
            </>}
        </div>
      </div>
      // Only an Organization-wide Canvas can be joined; anyone else not listed is added by a manager.
      : <div className="canvas-notices-record-controls">
        <span>{detail.data?.visibility === 'workspace'
          ? 'You are not a participant, so these do not reach you.'
          : 'These reach the people this Canvas is shared with.'}</span>
        {detail.data?.visibility === 'workspace'
          && <div className="canvas-notices-record-actions">
            <Button disabled={actions.join.isPending} onClick={() => actions.join.mutate()}>Get notifications</Button>
          </div>}
      </div>)}
    {pushing && <DevicePushLine />}
    {detail.error && <ErrorNotice occurrence={detail.error}>This Canvas's notices could not be loaded.</ErrorNotice>}
    {actions.error && <ErrorNotice occurrence={actions.error}>{actions.error.message}</ErrorNotice>}
  </section>;
}

/**
 * The title menu's Notifications section; nothing while the Canvas's notices
 * are off. The menu closes on a choice, so a failure is the screen's to show.
 */
export function CanvasNoticesMenuSection({ canvas, disabled, onError }: {
  canvas: CanvasDetail | undefined; disabled: boolean; onError: (error: Error) => void;
}): React.JSX.Element | null {
  const labelId = useId();
  const actions = useCanvasNoticeActions(canvas?.id ?? '', onError);
  const notices = canvas?.notices;
  if (!canvas || !notices) return null;
  // Only an Organization-wide Canvas can be joined.
  if (!notices.participant && canvas.visibility !== 'workspace') return null;
  const off = actions.effective(notices).length === 0;
  return <>
    <TitleMenuSeparator />
    <DropdownMenu.Group aria-labelledby={labelId} className="canvas-notices-menu">
      <DropdownMenu.Label className="menu-label workspace-menu-section" id={labelId}>Notifications</DropdownMenu.Label>
      {!notices.participant
        ? <MenuActionItem className="menu-item title-menu-item title-menu-action" disabled={disabled} onSelect={() => actions.join.mutate()}>
          <IconBell aria-hidden="true" size={16} stroke={1.8} />
          <span className="title-menu-item-copy">Get notifications</span>
        </MenuActionItem>
        : off
          ? <MenuActionItem className="menu-item title-menu-item title-menu-action" disabled={disabled} onSelect={actions.turnOn}>
            <IconBell aria-hidden="true" size={16} stroke={1.8} />
            <span className="title-menu-item-copy">Turn on notifications</span>
          </MenuActionItem>
          : <MenuActionItem className="menu-item title-menu-item title-menu-action" disabled={disabled} onSelect={() => actions.choose.mutate([])}>
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
    <span className="canvas-notices-banner-copy"><strong>This Canvas sends notices.</strong> {purpose}</span>
    <span className="canvas-notices-banner-actions">
      <Button disabled={actions.join.isPending} onClick={() => actions.join.mutate()}>Get notifications</Button>
      <Button onClick={dismiss}>Not now</Button>
    </span>
    {actions.error && <ErrorNotice occurrence={actions.error}>{actions.error.message}</ErrorNotice>}
  </div>;
}
