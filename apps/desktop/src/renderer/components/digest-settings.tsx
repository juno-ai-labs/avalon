import { SettingToggle } from '../settings/setting-toggle';
import { DAY_PRESETS, WEEKDAYS } from '../settings/choices';
import { digestDeliverySetting } from '../settings/digest-provider';
import { settings } from '../settings/registry';
import { SettingLabel } from '../settings/setting-label';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock3, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { RallyApi } from '../lib/api';
import type {
  AutomationDeliveryTargetType,
  DigestSchedule,
  WorkstreamConnection,
} from '../lib/types';
import { RallyMark, Button, InlineError, LoadingState } from './primitives';

const MAX_TIMES = 12;

/** The settings surface depends on this pair, not the entire renderer client. */
export type DigestSettingsApi = Pick<RallyApi, 'getDigestSchedule' | 'updateDigestSchedule'>;

export function minutesToLabel(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const suffix = hour < 12 ? 'AM' : 'PM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  if (minute === 0 && hour === 12) return 'Noon';
  if (minute === 0 && hour === 0) return 'Midnight';
  return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/**
 * An instant, read in the digest's own timezone rather than the machine's.
 *
 * Someone who sets 9:00 AM Pacific and reads "Next one 4:15 AM" on a UTC laptop
 * has been told something true and useless. The schedule is expressed in one
 * timezone, so every instant derived from it is shown in that same one.
 */
export function instantInTimezone(value: string, timezone: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit', timeZone: timezone,
    }).format(at);
  } catch {
    return at.toLocaleString();
  }
}

export function minutesToInputValue(minuteOfDay: number): string {
  return `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`;
}

export function inputValueToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function sameDays(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((day, index) => day === right[index]);
}

/** The description under the heading: what this digest currently does, in words. */
export function digestSummaryText(schedule: {
  enabled: boolean;
  days: number[];
  times: number[];
}): string {
  if (!schedule.enabled) return 'Digests are off.';
  if (schedule.days.length === 0 || schedule.times.length === 0) {
    return 'Pick at least one day and one time.';
  }
  const preset = DAY_PRESETS.find((candidate) => sameDays(candidate.days, schedule.days));
  const dayText = preset
    ? preset.label.toLocaleLowerCase()
    : schedule.days.map((day) => WEEKDAYS[day]!.name).join(', ');
  const timeText = schedule.times.map(minutesToLabel).join(', ');
  return `${schedule.times.length === 1 ? 'Once' : `${schedule.times.length} times`} on ${dayText}, at ${timeText}.`;
}

interface DraftSchedule {
  enabled: boolean;
  days: number[];
  times: number[];
  targetKeys: string[];
}

/** Stable identity for a destination, since email has no connection to key on. */
function targetKey(type: AutomationDeliveryTargetType, connectionId: string | null): string {
  return connectionId ? `${type}:${connectionId}` : type;
}

function draftFromSchedule(schedule: DigestSchedule): DraftSchedule {
  return {
    enabled: schedule.enabled,
    days: [...schedule.days].sort((left, right) => left - right),
    times: [...schedule.times].sort((left, right) => left - right),
    targetKeys: schedule.deliveryTargets.map((target) => targetKey(target.type, target.connectionId)),
  };
}

export function DigestSettings({
  api,
  connections,
  onEditTimezone,
}: {
  api: DigestSettingsApi;
  connections: WorkstreamConnection[];
  /** Takes the reader to the one place the timezone is actually set. */
  onEditTimezone: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DraftSchedule | null>(null);
  const [pendingTime, setPendingTime] = useState('09:00');
  const [timeError, setTimeError] = useState<string | null>(null);

  const digest = useQuery({
    queryKey: ['digest-schedule'],
    queryFn: ({ signal }) => api.getDigestSchedule(signal),
    staleTime: 15_000,
  });

  // The server's copy is the source of truth until it is edited; re-seeding on
  // every fetch would throw away edits made while a refetch was in flight.
  useEffect(() => {
    if (digest.data && !draft) setDraft(draftFromSchedule(digest.data));
  }, [digest.data, draft]);

  const save = useMutation({
    mutationFn: (next: DraftSchedule) => api.updateDigestSchedule({
      enabled: next.enabled,
      days: next.days,
      times: next.times,
      deliveryTargets: next.targetKeys.map((key) => {
        const [type, connectionId] = key.split(':', 2) as [AutomationDeliveryTargetType, string | undefined];
        return { type, connectionId: connectionId ?? null };
      }),
    }),
    onSuccess: (saved) => {
      setDraft(draftFromSchedule(saved));
      queryClient.setQueryData(['digest-schedule'], saved);
    },
  });

  // A connector offers itself as a destination only once it can actually reach
  // this person; the API sets `userDelivery` exactly when that is true, so this
  // list grows with the connector catalog and never with this file.
  const deliveryConnections = useMemo(
    () => connections.filter((connection) => connection.userDelivery),
    [connections],
  );

  // The error branch comes first: a failed load leaves `draft` null forever, so
  // checking for the draft ahead of it would show "Loading" with nothing coming.
  if (digest.error) return <InlineError>{digest.error.message}</InlineError>;
  const saved = digest.data;
  if (!saved || !draft) return <LoadingState label="Loading your digest" />;

  const update = (patch: Partial<DraftSchedule>): void => setDraft({ ...draft, ...patch });
  const toggleDay = (day: number): void => update({
    days: draft.days.includes(day)
      ? draft.days.filter((candidate) => candidate !== day)
      : [...draft.days, day].sort((left, right) => left - right),
  });
  const toggleTarget = (key: string): void => {
    if (draft.targetKeys.includes(key)) {
      return update({ targetKeys: draft.targetKeys.filter((candidate) => candidate !== key) });
    }
    // One destination per target type, matching the table. Two Slack
    // installations are two connections but one Slack DM surface, so picking the
    // second replaces the first rather than composing a save the API refuses.
    const type = key.split(':', 1)[0];
    update({
      targetKeys: [...draft.targetKeys.filter((candidate) => candidate.split(':', 1)[0] !== type), key],
    });
  };
  const addTime = (): void => {
    const minutes = inputValueToMinutes(pendingTime);
    if (minutes === null) return setTimeError('Enter a time as HH:MM.');
    if (draft.times.includes(minutes)) return setTimeError('That time is already on the list.');
    if (draft.times.length >= MAX_TIMES) return setTimeError(`A digest can run at most ${MAX_TIMES} times a day.`);
    setTimeError(null);
    update({ times: [...draft.times, minutes].sort((left, right) => left - right) });
  };

  const incomplete = draft.enabled
    && (draft.days.length === 0 || draft.times.length === 0 || draft.targetKeys.length === 0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromSchedule(saved));

  return (
    <section aria-labelledby="settings-title" className="settings-pane">
      <div className="settings-pane-heading">
        <h2>Schedule</h2>
        <p>
          A written summary of what moved since your last one — work streams you are in, anything
          that tagged you, and activity from your connected tools. {digestSummaryText(draft)}
        </p>
      </div>

      <div className="settings-list-card">
        <SettingToggle
          setting={settings.digestEnabled}
          description={draft.enabled && saved.nextRunAt
          ? `Next one ${instantInTimezone(saved.nextRunAt, saved.timezone)}.`
          : 'Rally writes it at the times you choose and sends it where you choose.'}
          checked={draft.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
      </div>

      <div className="settings-pane-heading settings-pane-heading-spaced"><h2><SettingLabel setting={settings.digestDays} /></h2></div>
      <div className="settings-list-card digest-card">
        <div className="digest-day-presets" role="group" aria-label="Day presets">
          {DAY_PRESETS.map((preset) => (
            <button
              aria-pressed={sameDays(preset.days, draft.days)}
              className="digest-preset"
              key={preset.id}
              onClick={() => update({ days: [...preset.days] })}
              type="button"
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="digest-day-toggles" role="group" aria-label="Days of the week">
          {WEEKDAYS.map((weekday) => (
            <button
              aria-label={weekday.name}
              aria-pressed={draft.days.includes(weekday.day)}
              className="digest-day"
              key={weekday.day}
              onClick={() => toggleDay(weekday.day)}
              type="button"
            >
              {weekday.initial}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-pane-heading settings-pane-heading-spaced"><h2><SettingLabel setting={settings.digestTimes} /></h2></div>
      <div className="settings-list-card digest-card">
        {draft.times.length === 0
          ? <p className="digest-empty">No times yet. Add the first one below.</p>
          : (
            <ul className="digest-time-list">
              {draft.times.map((minuteOfDay) => (
                <li className="digest-time" key={minuteOfDay}>
                  <Clock3 aria-hidden="true" size={13} />
                  <span>{minutesToLabel(minuteOfDay)}</span>
                  <button
                    aria-label={`Remove ${minutesToLabel(minuteOfDay)}`}
                    onClick={() => update({ times: draft.times.filter((time) => time !== minuteOfDay) })}
                    type="button"
                  >
                    <X aria-hidden="true" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        <div className="digest-time-add">
          <input
            aria-label="New digest time"
            onChange={(event) => {
              setPendingTime(event.target.value);
              setTimeError(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              addTime();
            }}
            type="time"
            value={pendingTime}
          />
          <Button disabled={draft.times.length >= MAX_TIMES} onClick={addTime}>
            <Plus aria-hidden="true" size={13} /> Add time
          </Button>
        </div>
        {timeError && <InlineError>{timeError}</InlineError>}
        <p className="digest-timezone">
          {/* Not a picker. A digest runs in this person's own day, and Account
              already owns that preference; a second control here would be a
              second answer to the same question. */}
          <span>Times are in your timezone,</span>
          <strong>{saved.timezone}</strong>
          <button className="digest-timezone-link" onClick={onEditTimezone} type="button">
            Change in Account
          </button>
        </p>
      </div>

      <div className="settings-pane-heading settings-pane-heading-spaced"><h2><SettingLabel setting={settings.digestDelivery} /></h2></div>
      <div className="settings-list-card">
        <SettingToggle
          setting={settings.digestEmail}
          checked={draft.targetKeys.includes('email')}
          onChange={() => toggleTarget('email')}
        />
        {deliveryConnections.map((connection) => {
          const key = targetKey(connection.userDelivery!.targetType, connection.id);
          return (
            <SettingToggle
              setting={digestDeliverySetting(connection)}
              key={connection.id}
              checked={draft.targetKeys.includes(key)}
              onChange={() => toggleTarget(key)}
            />
          );
        })}
        {deliveryConnections.length === 0 && (
          <div className="settings-preference-row">
            <span className="settings-row-icon"><RallyMark /></span>
            <span className="settings-row-copy">
              <strong>Somewhere else</strong>
              <small>Connect a tool that can message you — like Slack — and it will appear here.</small>
            </span>
          </div>
        )}
      </div>

      <div className="digest-actions">
        <small>
          {incomplete
            ? 'An enabled digest needs at least one day, one time, and one destination.'
            : saved.lastDeliveredAt
              ? `Last sent ${instantInTimezone(saved.lastDeliveredAt, saved.timezone)}.`
              : 'Nothing has been sent yet.'}
        </small>
        <Button
          className="button-primary"
          disabled={!dirty || incomplete || save.isPending}
          onClick={() => save.mutate(draft)}
        >
          {save.isPending ? 'Saving…' : <SettingLabel setting={settings.digestSave} />}
        </Button>
      </div>
      {save.error && <InlineError>{save.error.message}</InlineError>}
    </section>
  );
}
