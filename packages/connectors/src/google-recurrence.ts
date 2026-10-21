import { z } from "zod";
import { calendarDayBoundary } from "./google-selectors";

export const GoogleRepeatSchema = z.strictObject({
  frequency: z.enum(["daily", "weekly", "monthly", "yearly"]).describe("How often the meeting repeats. Monthly/yearly schedules repeat on the first occurrence's calendar day."),
  interval: z.number().int().positive().optional().describe("Repeat every this many days/weeks/months/years. Omit for every one; 2 with weekly means every other week."),
  weekdays: z.array(z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])).min(1).optional().describe("Days of the week for a weekly schedule, for example [monday, wednesday]. Omit to repeat on the first occurrence's weekday."),
  until: z.string().date().optional().describe("Last local date on which a meeting may occur, YYYY-MM-DD, inclusive. Omit for no ending date. Use this or occurrences, not both."),
  occurrences: z.number().int().positive().optional().describe("Total number of meetings, including the first. Omit for no count limit. Use this or until, not both."),
}).superRefine((value, ctx) => {
  if (value.until && value.occurrences) ctx.addIssue({ code: "custom", path: ["until"], message: "Choose until or occurrences, not both" });
  if (value.weekdays && value.frequency !== "weekly") ctx.addIssue({ code: "custom", path: ["weekdays"], message: "weekdays is for weekly schedules; omit it for daily, monthly or yearly schedules" });
});
export function googleRecurrenceRule(repeat: z.infer<typeof GoogleRepeatSchema>, allDay: boolean, timeZone: string): string {
  const fields = [`FREQ=${repeat.frequency.toUpperCase()}`];
  if (repeat.interval !== undefined) fields.push(`INTERVAL=${repeat.interval}`);
  const weekdays = { monday: "MO", tuesday: "TU", wednesday: "WE", thursday: "TH", friday: "FR", saturday: "SA", sunday: "SU" };
  if (repeat.weekdays) fields.push(`BYDAY=${[...new Set(repeat.weekdays)].map((day) => weekdays[day]).join(",")}`);
  if (repeat.occurrences) fields.push(`COUNT=${repeat.occurrences}`);
  if (repeat.until) {
    const nextDate = new Date(Date.parse(`${repeat.until}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const until = allDay ? repeat.until.replaceAll("-", "") : new Date(Date.parse(calendarDayBoundary(nextDate, timeZone)) - 1_000).toISOString().replaceAll(/[-:]/gu, "").replace(".000", "");
    fields.push(`UNTIL=${until}`);
  }
  return `RRULE:${fields.join(";")}`;
}
