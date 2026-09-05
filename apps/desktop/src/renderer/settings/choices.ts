/** Sunday first, matching `Date#getDay` and every calendar in the product. */
export const WEEKDAYS = [
  { day: 0, initial: 'S', name: 'Sunday' },
  { day: 1, initial: 'M', name: 'Monday' },
  { day: 2, initial: 'T', name: 'Tuesday' },
  { day: 3, initial: 'W', name: 'Wednesday' },
  { day: 4, initial: 'T', name: 'Thursday' },
  { day: 5, initial: 'F', name: 'Friday' },
  { day: 6, initial: 'S', name: 'Saturday' },
] as const;

export const DAY_PRESETS = [
  { id: 'every-day', label: 'Every day', days: [0, 1, 2, 3, 4, 5, 6] },
  { id: 'weekdays', label: 'Weekdays', days: [1, 2, 3, 4, 5] },
  { id: 'weekends', label: 'Weekends', days: [0, 6] },
] as const;


