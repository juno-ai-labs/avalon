import {
  NotificationKindSchema,
  type NotificationChannel,
  type NotificationKind,
} from '@rally/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Mail, MessageCircle } from 'lucide-react';

import type { RallyApi } from '../lib/api';
import { UNLINKED_DELIVERY_TARGETS, type AutomationDeliveryTargetType, type DigestDeliveryTargetType, type DigestSchedule, type WorkstreamConnection } from '../lib/types';
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
  api: RallyApi;
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
              none="Digest only"
              onToggle={(channel) => toggle(kind, channel)}
              options={options}
              selected={notify[kind]}
            />
          </div>
        ))}
      </div>
      <p className="settings-footnote">
        None selected means you won't be told, apart from your digest. Connected messaging apps
        that can reach you show up here.
      </p>
      {save.error && <ErrorNotice occurrence={save.error}>{save.error.message}</ErrorNotice>}
    </section>
  );
}

const NOON = 12 * 60;
/** Every 15 minutes from `from` through `through`, both minutes of the day. */
const quarterHours = (from: number, through: number) =>
  Array.from({ length: (through - from) / 15 + 1 }, (_, index) => from + index * 15);
const MORNING_TIMES = quarterHours(7.5 * 60, 9.5 * 60);
const EVENING_TIMES = quarterHours(16.5 * 60, 18.5 * 60);
const DEFAULT_MORNING = 7.75 * 60;
const DEFAULT_EVENING = 17.5 * 60;
const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

export function minutesToLabel(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  if (minute === 0 && hour === 12) return 'Noon';
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** What the screen edits: the two slots and where they go, read from the stored schedule. */
interface DigestDraft {
  morning: number | null;
  evening: number | null;
  days: number[];
  targets: Array<{ type: DigestDeliveryTargetType; connectionId: string | null }>;
}

/**
 * A stored schedule as its two slots: the first time before noon is the start
 * of the day, the first after it the end. A slot with a time is on, unless
 * the digest was switched off with somewhere to send it and days to send it
 * on: that is a digest someone turned off, where one with nowhere to go is
 * only waiting for a destination.
 */
export function draftFromSchedule(schedule: DigestSchedule): DigestDraft {
  const on = schedule.enabled || schedule.deliveryTargets.length === 0 || schedule.days.length === 0;
  return {
    morning: on ? schedule.times.find((time) => time < NOON) ?? null : null,
    evening: on ? schedule.times.find((time) => time >= NOON) ?? null : null,
    days: schedule.days,
    targets: schedule.deliveryTargets.map((target) => ({ type: target.type, connectionId: target.connectionId })),
  };
}

/** The stored schedule a draft saves as. Nothing on, or nowhere to send it, is a digest switched off. */
export function scheduleFromDraft(draft: DigestDraft) {
  const times = [draft.morning, draft.evening].filter((time): time is number => time !== null);
  return {
    enabled: times.length > 0 && draft.targets.length > 0 && draft.days.length > 0,
    days: draft.days,
    times,
    deliveryTargets: draft.targets,
  };
}

/**
 * Settings → Notifications → Daily digest: what is still unread, sent at the
 * start and end of the day to email or a connected messaging app. A stored
 * `personal_channel` target is kept but no longer offered: nothing in the
 * client opens the Thread it posts into. Each change saves at once.
 */
export function DailyDigestSettings({ api, connections, onEditTimezone }: {
  api: Pick<RallyApi, 'getDigestSchedule' | 'updateDigestSchedule'>;
  connections: readonly WorkstreamConnection[];
  onEditTimezone: () => void;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const digest = useQuery({
    queryKey: ['digest-schedule'],
    queryFn: ({ signal }) => api.getDigestSchedule(signal),
    staleTime: 15_000,
    // Names the account's zone, which a device report elsewhere can move.
    refetchOnWindowFocus: true,
  });
  const save = useMutation({
    // One at a time, in the order made: each save replaces the whole schedule.
    scope: { id: 'digest-schedule' },
    mutationFn: (draft: DigestDraft) => api.updateDigestSchedule(scheduleFromDraft(draft)),
    onSuccess: (saved) => queryClient.setQueryData(['digest-schedule'], saved),
  });
  if (digest.error) return <ErrorNotice occurrence={digest.error}>{digest.error.message}</ErrorNotice>;
  if (!digest.data) return null;
  const saved = digest.data;
  // The draft being saved, so a second change builds on the first.
  const draft = save.isPending && save.variables ? save.variables : draftFromSchedule(saved);
  const change = (patch: Partial<DigestDraft>) => save.mutate({ ...draft, ...patch });

  const surfaces = connectorSurfaces(connections);
  const email = saved.deliveryTargets.find((target) => target.type === 'email')?.displayName;
  const options: ChannelOption[] = [
    { id: 'email', label: 'Email', hint: email ? `To ${email}` : 'To your account address', icon: <Mail aria-hidden="true" size={ICON_SIZE} /> },
    ...surfaces.map(connectorOption),
  ];
  const toggleTarget = (type: string) => {
    const chosen = draft.targets.some((target) => target.type === type);
    const connectionId = surfaces.find((connection) => connection.userDelivery!.targetType === type)?.id ?? null;
    change({
      targets: chosen
        ? draft.targets.filter((target) => target.type !== type)
        : [...draft.targets, { type: type as DigestDeliveryTargetType, connectionId }],
    });
  };
  const slots = [
    { key: 'morning' as const, setting: settings.digestStartOfDay, times: MORNING_TIMES, fallback: DEFAULT_MORNING },
    { key: 'evening' as const, setting: settings.digestEndOfDay, times: EVENING_TIMES, fallback: DEFAULT_EVENING },
  ];
  const sameDays = (days: readonly number[]) => days.length === draft.days.length && days.every((day) => draft.days.includes(day));

  return (
    <section className="settings-pane">
      <div className="settings-pane-heading settings-pane-heading-spaced">
        <h2>Daily digest</h2>
        <p>Whatever is still unread, in one message. Nothing unread, nothing sent.</p>
      </div>
      <div className="settings-list-card">
        {slots.map((slot) => {
          const time = draft[slot.key];
          const shown = time ?? saved.times.find((candidate) => slot.key === 'morning' ? candidate < NOON : candidate >= NOON) ?? slot.fallback;
          const choices = slot.times.includes(shown) ? slot.times : [...slot.times, shown].sort((left, right) => left - right);
          return (
            <div className="settings-preference-row digest-slot" key={slot.key}>
              <SettingCopy setting={slot.setting} />
              <span className="digest-slot-controls">
                <select
                  aria-label={`${slot.setting.label} time`}
                  className="digest-slot-time"
                  disabled={time === null}
                  onChange={(event) => change({ [slot.key]: Number(event.target.value) })}
                  value={shown}
                >
                  {choices.map((choice) => <option key={choice} value={choice}>{minutesToLabel(choice)}</option>)}
                </select>
                <label className="settings-toggle">
                  <input
                    aria-label={`${slot.setting.label} digest`}
                    checked={time !== null}
                    onChange={(event) => change({ [slot.key]: event.target.checked ? shown : null })}
                    role="switch"
                    type="checkbox"
                  />
                  <span aria-hidden="true" />
                </label>
              </span>
            </div>
          );
        })}
        <div className="settings-preference-row">
          <SettingCopy setting={settings.digestSendTo} />
          <ChannelPicker
            label="Send the digest to"
            none="Nowhere"
            onToggle={toggleTarget}
            options={options}
            selected={draft.targets.map((target) => target.type)}
          />
        </div>
        <div className="settings-preference-row">
          <SettingCopy
            setting={settings.digestDays}
            description={<>In your timezone, {saved.timezone}. <button className="digest-timezone-link" onClick={onEditTimezone} type="button">Change</button></>}
          />
          <span aria-label="Digest days" className="segmented" role="radiogroup">
            {[{ label: 'Weekdays', days: WEEKDAYS }, { label: 'Every day', days: EVERY_DAY }].map((choice) => (
              <button
                aria-checked={sameDays(choice.days)}
                key={choice.label}
                onClick={() => change({ days: choice.days })}
                role="radio"
                type="button"
              >
                {choice.label}
              </button>
            ))}
          </span>
        </div>
      </div>
      {save.error && <ErrorNotice occurrence={save.error}>{save.error.message}</ErrorNotice>}
    </section>
  );
}
