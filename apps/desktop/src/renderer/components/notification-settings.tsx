import {
  OFFERED_NOTIFICATION_KINDS,
  type NotificationChannel,
  type OfferedNotificationKind,
} from '@rally/contracts';
import { Bell, Mail } from 'lucide-react';

import type { RallyApi } from '../lib/api';
import { useMemberPreferences, useSaveMemberPreferences } from '../lib/use-member-preferences';
import { settings, type SettingDefinition } from '../settings/registry';
import { SettingCopy } from '../settings/setting-label';
import { ChannelPicker, type ChannelOption } from './channel-picker';
import { ErrorNotice } from './primitives';

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
  api: Pick<RallyApi, 'getMyPreferences' | 'updateMyPreferences'>;
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
        {OFFERED_NOTIFICATION_KINDS.map((kind) => ({ kind, setting: KIND_SETTINGS[kind] })).map(({ kind, setting }) => (
          <div className="settings-preference-row" key={kind}>
            <SettingCopy setting={setting} />
            <ChannelPicker
              label={`How to tell you about ${midSentence(setting.label)}`}
              none="Off"
              onToggle={(channel) => toggle(kind, channel as NotificationChannel)}
              options={options}
              selected={notify[kind] ?? []}
            />
          </div>
        ))}
      </div>
      <p className="settings-footnote">None selected means you won't be told.</p>
      {save.error && <ErrorNotice occurrence={save.error}>{save.error.message}</ErrorNotice>}
    </section>
  );
}
