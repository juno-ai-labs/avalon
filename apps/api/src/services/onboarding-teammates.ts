import { z } from 'zod';

const calendarPage = z.object({
  items: z.array(z.object({
    id: z.string(), status: z.string().nullish(), attendeesOmitted: z.boolean().optional(),
    attendeesTruncated: z.boolean().optional(),
    attendees: z.array(z.object({ email: z.string().nullish(), displayName: z.string().nullish(),
      self: z.boolean().optional(), responseStatus: z.string().nullish() })).optional(),
  })), nextPageToken: z.string().nullish(),
});

/** Only identities and meeting counts leave this function; never event content. */
export function teammatesFromCalendarPage(raw: unknown, excludedEmails: ReadonlySet<string>) {
  const page = calendarPage.parse(raw);
  const candidates = new Map<string, { email: string; name: string; meetings: string[] }>();
  for (const event of page.items) {
    if (event.status === 'cancelled' || event.attendees?.some((person) => person.self && person.responseStatus === 'declined')) continue;
    for (const person of event.attendees ?? []) {
      const email = person.email?.trim().toLowerCase();
      if (!email || !z.email().safeParse(email).success || person.self || person.responseStatus === 'declined' || excludedEmails.has(email)) continue;
      const candidate = candidates.get(email) ?? { email, name: person.displayName || email, meetings: [] };
      if (!candidate.meetings.includes(event.id)) candidate.meetings.push(event.id);
      candidates.set(email, candidate);
    }
  }
  return { items: [...candidates.values()].sort((a, b) => b.meetings.length - a.meetings.length || a.email.localeCompare(b.email)),
    nextPageToken: page.nextPageToken || null,
    partial: page.items.some((event) => event.attendeesOmitted || event.attendeesTruncated),
  };
}
