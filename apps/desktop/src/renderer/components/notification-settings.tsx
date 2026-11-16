import {
  OFFERED_NOTIFICATION_KINDS,
  type CanvasNoticeChoices,
  type NotificationChannel,
  type OfferedNotificationKind,
} from '@rally/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Mail } from 'lucide-react';

import type { RallyApi } from '../lib/api';
import { canvasDetailQueryKey } from '../lib/canvases';
import { useMemberPreferences, useSaveMemberPreferences } from '../lib/use-member-preferences';
import { settings, type SettingDefinition } from '../settings/registry';
import { SettingCopy } from '../settings/setting-label';
import { ChannelPicker, type ChannelOption } from './channel-picker';
import { Button, ErrorNotice } from './primitives';

const ICON_SIZE = 14;

/**
 * Each offered kind's copy. Which kinds, and their order, are the contract's
 * (`OFFERED_NOTIFICATION_KINDS`): exactly the kinds a producer records
 * (docs/member-preferences.md).
 */
const KIND_SETTINGS: Record<OfferedNotificationKind, SettingDefinition> = {
  mentions: settings.notifyMentions,
  newMessages: settings.notifyNewMessages,
  added: settings.notifyAdded,
  runFinished: settings.notifyRunFinished,
  artifactUpdates: settings.notifyArtifactUpdates,
  accessRequests: settings.notifyAccessRequests,
  sourceRequests: settings.notifySourceRequests,
  canvasNotices: settings.notifyCanvasNotices,
};

/** Product nouns keep their capital mid-sentence ("Sidekick runs", "pinned Canvas updates"). */
const PRODUCT_NOUNS = new Set(['Canvas', 'Canvases', 'Sidekick', 'Sidekicks', 'Rally']);

/** A setting's label as the rest of a sentence: its first word lower-cased unless it is a product noun. */
function midSentence(label: string): string {
  const [first = ''] = label.split(' ');
  return PRODUCT_NOUNS.has(first) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * Settings → Notifications → Notify me about: how each kind of Activity
 * reaches this person, on every device: push and email, the same two for
 * every kind.
 */
export function NotificationChannelSettings({ api, workspaceId, pushAvailable, email }: {
  api: Pick<RallyApi, 'getMyPreferences' | 'updateMyPreferences' | 'canvasNoticeChoices' | 'setCanvasNoticeChoice' | 'joinCanvas'>;
  workspaceId: string;
  /** Push is offered only where this deployment can push. */
  pushAvailable: boolean;
  email: string | null;
}): React.JSX.Element {
  const preferences = useMemberPreferences(api, workspaceId);
  const save = useSaveMemberPreferences(api, workspaceId);
  const notify = preferences.data.notify;
  const options: ChannelOption[] = [
    ...(pushAvailable ? [{ id: 'push', label: 'Push', hint: 'On every device signed in', icon: <Bell aria-hidden="true" size={ICON_SIZE} /> }] : []),
    { id: 'email', label: 'Email', hint: email ? `To ${email}` : 'To your account address', icon: <Mail aria-hidden="true" size={ICON_SIZE} /> },
  ];
  // Push stays chosen where this deployment cannot push, so a save keeps it
  // though it is not drawn. A stored Slack choice never reaches here: the
  // contract's channel list drops it on read, so a save does not send it back.
  const toggle = (kind: OfferedNotificationKind, channel: NotificationChannel) => {
    const chosen = notify[kind] ?? [];
    save.mutate({
      notify: { [kind]: chosen.includes(channel) ? chosen.filter((candidate) => candidate !== channel) : [...chosen, channel] },
    });
  };
  return (
    <section className="settings-pane">
      <div className="settings-pane-heading settings-pane-heading-spaced">
        <h2>Notify me about</h2>
        <p>Pick how each kind reaches you. Applies on every device in this Organization.</p>
      </div>
      <div className="settings-list-card">
        {OFFERED_NOTIFICATION_KINDS.map((kind) => ({ kind, setting: KIND_SETTINGS[kind] })).map(({ kind, setting }) => [
          <div className="settings-preference-row" key={kind}>
            <SettingCopy setting={setting} />
            <ChannelPicker
              label={`How to tell you about ${midSentence(setting.label)}`}
              none="Off"
              onToggle={(channel) => toggle(kind, channel as NotificationChannel)}
              options={options}
              selected={notify[kind] ?? []}
            />
          </div>,
          // The Canvas notices row is the default; each Canvas that sends notices follows it until changed.
          kind === 'canvasNotices'
            && <CanvasNoticeRows api={api} defaults={notify.canvasNotices ?? []} key="canvas-notice-rows" options={options} workspaceId={workspaceId} />,
        ])}
      </div>
      <p className="settings-footnote">None selected means you won't be told.</p>
      {save.error && <ErrorNotice occurrence={save.error}>{save.error.message}</ErrorNotice>}
    </section>
  );
}

/**
 * One row per Canvas that sends notices, under the Canvas notices default. A
 * Canvas with no choice of its own shows the default; a change here becomes
 * that Canvas's choice, and Use default drops it. An Organization-wide
 * Canvas the person is not on is shown greyed, with a way to join it.
 */
function CanvasNoticeRows({ api, workspaceId, defaults, options }: {
  api: Pick<RallyApi, 'canvasNoticeChoices' | 'setCanvasNoticeChoice' | 'joinCanvas'>;
  workspaceId: string;
  defaults: readonly NotificationChannel[];
  options: ChannelOption[];
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const key = ['canvas-notice-choices', workspaceId];
  const choices = useQuery({ queryKey: key, queryFn: ({ signal }) => api.canvasNoticeChoices(signal) });
  const choose = useMutation({
    scope: { id: `canvas-notice-choices:${workspaceId}` },
    mutationFn: ({ canvasId, channels }: { canvasId: string; channels: NotificationChannel[] | null }) =>
      api.setCanvasNoticeChoice(canvasId, channels),
    onMutate: async ({ canvasId, channels }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<CanvasNoticeChoices>(key);
      if (previous) queryClient.setQueryData(key, { canvases: previous.canvases.map((row) => row.canvasId === canvasId ? { ...row, channels } : row) });
      return { previous };
    },
    onError: (_error, _choice, context) => { if (context?.previous) queryClient.setQueryData(key, context.previous); },
    // The open Canvas's record and menu read the same choice.
    onSuccess: (detail) => queryClient.setQueryData(canvasDetailQueryKey(detail.id), detail),
  });
  const join = useMutation({
    mutationFn: (canvasId: string) => api.joinCanvas(canvasId),
    onSuccess: (detail) => {
      queryClient.setQueryData(canvasDetailQueryKey(detail.id), detail);
      queryClient.setQueryData<CanvasNoticeChoices>(key, (current) => current
        && { canvases: current.canvases.map((row) => row.canvasId === detail.id ? { ...row, participant: true } : row) });
    },
  });
  const rows = choices.data?.canvases ?? [];
  if (rows.length === 0 && !choices.error) return null;
  return <>
    {rows.map((row) => {
      if (!row.participant) {
        return <div className="settings-preference-row settings-preference-row-nested is-unjoined" key={row.canvasId}>
          <span className="settings-row-copy">
            <strong>{row.title}</strong>
            <small>You are not a participant, so these do not reach you. {row.purpose}</small>
            <span className="settings-row-inline-action">
              <Button disabled={join.isPending} onClick={() => join.mutate(row.canvasId)}>Add as participant</Button>
            </span>
          </span>
          <ChannelPicker disabled label={`How ${row.title} tells you`} none="Off" onToggle={() => undefined}
            options={options} selected={row.channels ?? defaults} />
        </div>;
      }
      const selected = row.channels ?? defaults;
      const toggle = (channel: NotificationChannel) => choose.mutate({ canvasId: row.canvasId,
        channels: selected.includes(channel) ? selected.filter((candidate) => candidate !== channel) : [...selected, channel] });
      return <div className="settings-preference-row settings-preference-row-nested" key={row.canvasId}>
        <span className="settings-row-copy">
          <strong>{row.title}</strong>
          <small>{row.channels === null ? 'Follows the default above.' : 'Set for this Canvas.'} {row.purpose}</small>
          {row.channels !== null && <span className="settings-row-inline-action">
            <Button onClick={() => choose.mutate({ canvasId: row.canvasId, channels: null })}>Use default</Button>
          </span>}
        </span>
        {/* A direct child of the row, which it measures to decide between buttons and a menu. */}
        <ChannelPicker label={`How ${row.title} tells you`} none="Off" onToggle={(channel) => toggle(channel as NotificationChannel)}
          options={options} selected={selected} />
      </div>;
    })}
    {choices.error && <ErrorNotice occurrence={choices.error}>Your Canvases' notices could not be loaded.</ErrorNotice>}
    {choose.error && <ErrorNotice occurrence={choose.error}>{choose.error.message}</ErrorNotice>}
    {join.error && <ErrorNotice occurrence={join.error}>{join.error.message}</ErrorNotice>}
  </>;
}
