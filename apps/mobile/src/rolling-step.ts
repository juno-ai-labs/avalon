/** Which item a rolling place shows, and which it is rolling away from. */
export type RollingStep = { index: number; previous: number | null };

export const FIRST_STEP: RollingStep = { index: 0, previous: null };

/** The next step through `count` items, back to the first after the last. */
export function nextStep(step: RollingStep, count: number): RollingStep {
  return { index: (step.index + 1) % count, previous: step.index };
}

/** The items a step names, read within `items` so a step from a longer list never misses. */
export function stepItems<T>(items: readonly T[], step: RollingStep): { shown: T; before: T | null } {
  return { shown: items[step.index % items.length]!, before: step.previous === null ? null : items[step.previous % items.length]! };
}
