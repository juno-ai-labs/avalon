import type { AutomationSummary } from './types';

/**
 * Where a Sidekick stands, as its sidebar row and its home row say it (the
 * PRD's "working, next run, paused", design.html §3): waiting on someone
 * first, then a run under way, then its lifecycle.
 */
export type SidekickStatus = 'needs_input' | 'working' | 'paused' | 'draft' | 'active';

/**
 * Whether any run of the Sidekick works now: the row's `running` (any run),
 * or, from a server that predates it, the newest run's `runState`.
 */
export function sidekickWorking(row: Pick<AutomationSummary, 'running' | 'runState'>): boolean {
  return row.running ?? row.runState === 'working';
}

export function sidekickStatus(row: Pick<AutomationSummary, 'needsInput' | 'running' | 'runState' | 'status'>): SidekickStatus {
  if (row.needsInput || row.runState === 'needs_input') return 'needs_input';
  if (sidekickWorking(row)) return 'working';
  if (row.status === 'paused') return 'paused';
  if (row.status === 'draft') return 'draft';
  return 'active';
}

const SIX_DAYS_MS = 6 * 86_400_000;

/**
 * When a scheduled Sidekick next runs, the way design.html §3 writes it: the
 * weekday and the time ("Fri 2:00 PM") within the coming week, where a weekday
 * names one day, and the date beyond it, where it would not. In the schedule's
 * own zone when the server names it (`scheduleTimeZone`), so the row, the home
 * and the details' "Every Friday at 2:00 PM" say one time whatever the
 * machine's clock zone; in the machine's zone otherwise. A zone this runtime
 * does not know falls back to the machine's rather than drawing nothing.
 */
export function formatNextRun(value: string, weekday: 'short' | 'long' = 'short', now = new Date(), timeZone?: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const withinWeek = date.getTime() - now.getTime() < SIX_DAYS_MS;
  const options: Intl.DateTimeFormatOptions = withinWeek
    ? { weekday, hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat(undefined, timeZone ? { ...options, timeZone } : options).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }
}

/** The time a Sidekick last did something: its newest run's start, or its own last change while it has none. */
export function sidekickActivityAt(row: Pick<AutomationSummary, 'lastRunAt' | 'updatedAt'>): string {
  return row.lastRunAt ?? row.updatedAt;
}

/**
 * The home's Next column, as design.html §3 writes it: what wakes it ("On
 * alert", "On email"), else a schedule's next run ("Fri 2:00 PM"), else "On
 * request". The design's Incident triage wakes on an alert and a weekday
 * schedule and reads "On alert", so an alert outranks the schedule.
 */
export function sidekickNext(row: Pick<AutomationSummary, 'nextRunAt' | 'scheduleTimeZone' | 'status' | 'triggerKinds'>, now = new Date()): string {
  if (row.status !== 'active') return '—';
  const kinds = row.triggerKinds ?? [];
  if (kinds.includes('external_event')) return 'On alert';
  if (kinds.includes('inbound_email')) return 'On email';
  if (row.nextRunAt && (kinds.length === 0 || kinds.includes('schedule'))) return formatNextRun(row.nextRunAt, 'short', now, row.scheduleTimeZone);
  if (kinds.includes('manual')) return 'On request';
  return '—';
}
