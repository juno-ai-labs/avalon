import {
  NotificationKindSchema,
  type NotificationChannel,
  type NotificationKind,
} from '@rally/contracts';
import { Bell, Mail, MessageCircle } from 'lucide-react';

import type { RallyApi } from '../lib/api';
import { UNLINKED_DELIVERY_TARGETS, type AutomationDeliveryTargetType, type WorkstreamConnection } from '../lib/types';
import { useMemberPreferences, useSaveMemberPreferences } from '../lib/use-member-preferences';
import { settings, type SettingDefinition } from '../settings/registry';
import { SettingCopy } from '../settings/setting-label';
import { ChannelPicker, type ChannelOption } from './channel-picker';
import { ErrorNotice } from './primitives';

const ICON_SIZE = 14;

/** Each connection that can reach this person, once per surface: two Slack installations are one Slack. */
function connectorSurfaces(connections: readonly WorkstreamConnection[]): WorkstreamConnection[] {
  const seen = new Set<string>();
  return connections.filter((connection) => {
    if (!connection.userDelivery || seen.has(connection.userDelivery.targetType)) return false;
    seen.add(connection.userDelivery.targetType);
    return true;
  });
}

function connectorOption(connection: WorkstreamConnection): ChannelOption {
  return {
    id: connection.userDelivery!.targetType,
    label: connection.userDelivery!.label,
    hint: connection.userDelivery!.description,
    icon: <MessageCircle aria-hidden="true" size={ICON_SIZE} />,
  };
}

/**
 * The kinds offered, each with its copy. `newThreads`, `newBreakouts` and
 * `merges` are still stored kinds, but nothing in the client can start or
 * open what they announce, so they are not offered.
 */
const KIND_SETTINGS: Partial<Record<NotificationKind, SettingDefinition>> = {
  mentions: settings.notifyMentions,
  newMessages: settings.notifyNewMessages,
  added: settings.notifyAdded,
  runFinished: settings.notifyRunFinished,
  artifactUpdates: settings.notifyArtifactUpdates,
};

/**
 * Settings → Notifications → Notify me about: how each kind of Activity
 * reaches this person, on every device. Push and email always; every
 * connection that can message them adds its own surface.
 */
export function NotificationChannelSettings({ api, workspaceId, connections, pushAvailable, email }: {
  api: Pick<RallyApi, 'getMyPreferences' | 'updateMyPreferences'>;
  workspaceId: string;
  connections: readonly WorkstreamConnection[];
  /** Push is offered only where this deployment can push. */
  pushAvailable: boolean;
  email: string | null;
}): React.JSX.Element {
  const preferences = useMemberPreferences(api, workspaceId);
  const save = useSaveMemberPreferences(api, workspaceId);
  const notify = preferences.data.notify;
  const offered: ChannelOption[] = [
    ...(pushAvailable ? [{ id: 'push', label: 'Push', hint: 'On every device signed in', icon: <Bell aria-hidden="true" size={ICON_SIZE} /> }] : []),
    { id: 'email', label: 'Email', hint: email ? `To ${email}` : 'To your account address', icon: <Mail aria-hidden="true" size={ICON_SIZE} /> },
    ...connectorSurfaces(connections).map(connectorOption),
  ];
  // A connector channel that is chosen and can still reach this person stays
  // on screen so it can be turned off, though no connection offers it: Slack
  // reaches someone who has not linked their account by their email address.
  const options: ChannelOption[] = [
    ...offered,
    ...[...new Set(Object.values(notify).flat())].flatMap((channel) => {
      const unlinked = UNLINKED_DELIVERY_TARGETS[channel as AutomationDeliveryTargetType];
      if (!unlinked || offered.some((option) => option.id === channel)
        || !connections.some((connection) => connection.connectorType === unlinked.connectorType && connection.status !== 'disabled')) return [];
      return [{
        id: channel,
        label: unlinked.label,
        hint: 'Found by your email address. Link your account in Connections.',
        icon: <MessageCircle aria-hidden="true" size={ICON_SIZE} />,
      }];
    }),
  ];
  // A channel stored but not offered here, such as Slack once disconnected,
  // stays in the list: only the one toggled is added or removed.
  const toggle = (kind: NotificationKind, channel: string) => save.mutate({
    notify: {
      [kind]: notify[kind].includes(channel as NotificationChannel)
        ? notify[kind].filter((candidate) => candidate !== channel)
        : [...notify[kind], channel as NotificationChannel],
    },
  });
  return (
    <section className="settings-pane">
      <div className="settings-pane-heading settings-pane-heading-spaced">
        <h2>Notify me about</h2>
        <p>Pick how each kind reaches you. Applies on every device in this Organization.</p>
      </div>
      <div className="settings-list-card">
        {NotificationKindSchema.options.flatMap((kind) => {
          const setting = KIND_SETTINGS[kind];
          return setting ? [{ kind, setting }] : [];
        }).map(({ kind, setting }) => (
          <div className="settings-preference-row" key={kind}>
            <SettingCopy setting={setting} />
            <ChannelPicker
              label={`How to tell you about ${setting.label.toLowerCase()}`}
              none="Off"
              onToggle={(channel) => toggle(kind, channel)}
              options={options}
              selected={notify[kind]}
            />
          </div>
        ))}
      </div>
      <p className="settings-footnote">
        None selected means you won't be told. Connected messaging apps
        that can reach you show up here.
      </p>
      {save.error && <ErrorNotice occurrence={save.error}>{save.error.message}</ErrorNotice>}
    </section>
  );
}
