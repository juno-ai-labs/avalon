import type { AutomationSummary } from './types';

/**
 * Where a Sidekick stands, as its sidebar row and its home row say it (the
 * PRD's "working, next run, paused", design.html §3): waiting on someone
 * first, then a run under way, then its lifecycle.
 */
export type SidekickStatus = 'needs_input' | 'working' | 'paused' | 'draft' | 'active';

export function sidekickStatus(row: Pick<AutomationSummary, 'needsInput' | 'runState' | 'status'>): SidekickStatus {
  if (row.needsInput || row.runState === 'needs_input') return 'needs_input';
  if (row.runState === 'working') return 'working';
  if (row.status === 'paused') return 'paused';
  if (row.status === 'draft') return 'draft';
  return 'active';
}

const SIX_DAYS_MS = 6 * 86_400_000;

/**
 * When a scheduled Sidekick next runs, the way design.html §3 writes it: the
 * weekday and the time ("Fri 2:00 PM") within the coming week, where a weekday
 * names one day, and the date beyond it, where it would not.
 */
export function formatNextRun(value: string, weekday: 'short' | 'long' = 'short', now = new Date()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const withinWeek = date.getTime() - now.getTime() < SIX_DAYS_MS;
  return new Intl.DateTimeFormat(undefined, withinWeek
    ? { weekday, hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

/** The time a Sidekick last did something: its newest run's start, or its own last change while it has none. */
export function sidekickActivityAt(row: Pick<AutomationSummary, 'lastRunAt' | 'updatedAt'>): string {
  return row.lastRunAt ?? row.updatedAt;
}

/**
 * The home's Next column, as design.html §3 writes it: a schedule's next run
 * ("Fri 2:00 PM"), else what wakes it ("On alert", "On email", "On request"),
 * taking the first of those by that precedence when it has several.
 */
export function sidekickNext(row: Pick<AutomationSummary, 'nextRunAt' | 'status' | 'triggerKinds'>, now = new Date()): string {
  if (row.status !== 'active') return '—';
  const kinds = row.triggerKinds ?? [];
  if (row.nextRunAt && (kinds.length === 0 || kinds.includes('schedule'))) return formatNextRun(row.nextRunAt, 'short', now);
  if (kinds.includes('external_event')) return 'On alert';
  if (kinds.includes('inbound_email')) return 'On email';
  if (kinds.includes('manual')) return 'On request';
  return '—';
}
