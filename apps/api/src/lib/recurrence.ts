import { rrulestr } from "rrule";

export function nextRRuleOccurrence(
  rule: string,
  timezone: string,
  dtstart: Date,
  after: Date,
): Date | null {
  const source = rule.includes("RRULE:") ? rule : `RRULE:${rule}`;
  const occurrence = rrulestr(source, {
    dtstart: instantToWallClock(dtstart, timezone),
    tzid: "UTC",
  }).after(instantToWallClock(after, timezone), false);
  if (!occurrence) return null;
  return wallClockToInstant(occurrence, timezone);
}

function instantToWallClock(value: Date, timezone: string): Date {
  const parts = zonedParts(value, timezone);
  return new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    value.getUTCMilliseconds(),
  ));
}

function wallClockToInstant(value: Date, timezone: string): Date {
  const target = value.getTime();
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = zonedParts(new Date(guess), timezone);
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      value.getUTCMilliseconds(),
    );
    const difference = target - represented;
    if (difference === 0) break;
    guess += difference;
  }
  return new Date(guess);
}

function zonedParts(value: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}
