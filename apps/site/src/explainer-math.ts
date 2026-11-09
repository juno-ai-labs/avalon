/**
 * The arithmetic behind the site's two explainers, kept apart from the DOM so
 * each figure is a pure function of its input (a time of day, a team size).
 * `explainers.ts` draws what these return.
 */

/** Where a source sits in the live-Canvas diagram, top to bottom. */
export const SOURCES = ['Schedule', 'Gmail', 'GitHub', 'Granola'] as const;
export type Source = (typeof SOURCES)[number];

/** A signal in the day: minutes after midnight, and whether it matches the Sidekick's condition. */
export type DayEvent = { minute: number; source: Source; text: string; matches: boolean };

export const DAY: readonly DayEvent[] = [
  { minute: 7 * 60, source: 'Schedule', text: 'Morning refresh', matches: true },
  { minute: 9 * 60 + 12, source: 'Gmail', text: 'Acme replied about the contract', matches: true },
  { minute: 10 * 60 + 15, source: 'Gmail', text: 'A vendor newsletter', matches: false },
  { minute: 11 * 60 + 30, source: 'GitHub', text: 'PR #812 merged', matches: true },
  { minute: 13 * 60 + 5, source: 'Granola', text: 'Call notes: Northwind', matches: true },
  { minute: 14 * 60 + 40, source: 'GitHub', text: 'A comment on an old issue', matches: false },
  { minute: 16 * 60 + 40, source: 'Gmail', text: 'Globex asked to move to Friday', matches: true },
  { minute: 18 * 60 + 30, source: 'Granola', text: 'Internal stand-up notes', matches: false },
];

/** Minutes a signal takes to reach the Sidekick, and then the Canvas. */
export const TRAVEL = 30;
/** The version the Canvas is on at midnight. */
export const START_VERSION = 1;

/**
 * Where one signal is at `minute`: not yet sent, on its way in (`inbound`,
 * with progress 0–1), dropped by the condition (`dropped`, fading 0–1 over
 * half a trip), on its way to the Canvas (`outbound`), or published (`done`).
 */
export type Phase =
  | { kind: 'waiting' }
  | { kind: 'inbound'; progress: number }
  | { kind: 'dropped'; progress: number }
  | { kind: 'outbound'; progress: number }
  | { kind: 'done' };

export function phaseAt(event: DayEvent, minute: number, filtered: boolean): Phase {
  const elapsed = minute - event.minute;
  if (elapsed < 0) return { kind: 'waiting' };
  if (elapsed < TRAVEL) return { kind: 'inbound', progress: elapsed / TRAVEL };
  if (filtered && !event.matches) {
    return elapsed < TRAVEL * 1.5 ? { kind: 'dropped', progress: (elapsed - TRAVEL) / (TRAVEL / 2) } : { kind: 'done' };
  }
  if (elapsed < TRAVEL * 2) return { kind: 'outbound', progress: (elapsed - TRAVEL) / TRAVEL };
  return { kind: 'done' };
}

/** Whether an event publishes a version, given the condition. */
export const publishes = (event: DayEvent, filtered: boolean): boolean => !filtered || event.matches;

/** The Canvas's version at `minute`: one more for every signal that has finished publishing. */
export function versionAt(minute: number, filtered: boolean, day: readonly DayEvent[] = DAY): number {
  return START_VERSION + day.filter((event) => publishes(event, filtered) && minute - event.minute >= TRAVEL * 2).length;
}

/** The most recent signal sent by `minute`, if any. */
export function latestAt(minute: number, day: readonly DayEvent[] = DAY): DayEvent | undefined {
  return day.filter((event) => event.minute <= minute).at(-1);
}

/** `09:05` for 545. */
export const clock = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(Math.floor(minute % 60)).padStart(2, '0')}`;

/** How many hand-offs a file passed between `people` needs for everyone to have had it from everyone: one per pair. */
export const pairs = (people: number): number => (people * (people - 1)) / 2;

export type Plan = { name: 'Start' | 'Grow'; monthly: number } | { name: 'Grown up'; monthly: null };

/**
 * The plan that fits a team of `people`, from the published tiers: Start is a
 * good fit under 5, Grow under 15, and above that the price is agreed.
 */
export function planFor(people: number): Plan {
  if (people < 5) return { name: 'Start', monthly: 100 };
  if (people < 15) return { name: 'Grow', monthly: 250 };
  return { name: 'Grown up', monthly: null };
}

/** The plan price shared by everyone on it, or null when the price is agreed. */
export function pricePerPerson(people: number): number | null {
  const { monthly } = planFor(people);
  return monthly === null ? null : monthly / people;
}
