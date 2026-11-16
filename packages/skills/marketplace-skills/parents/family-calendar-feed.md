---
name: "Family calendar feed"
description: "Keep shared appointments in sync with Apple Calendar or Google Calendar."
icon: "calendar-days"
color: "rose"
tags:
  - parents
connectors:
  - google-mail-and-calendar
---

Create a shared family calendar in this Canvas and give me an iCalendar subscription I can add to Apple Calendar or Google Calendar. Ask only which shared calendars or other sources to sync. When an event doesn't specify a timezone, use mine. Ask “What event details may the subscription show?” before exposing private family information to an external calendar client.

Combine appointments for kids and pets, travel, no-school days, and other shared commitments. Preserve all-day events, time zones, and recurring events. Use stable event IDs so a move, edit, or cancellation updates the existing entry, and merge duplicates only when the sources clearly refer to the same appointment. Show the event source and last successful sync in the Canvas.

Set up a Sidekick to keep the calendar current from the selected sources. Serve a read-only `.ics` feed with a stable HTTPS URL and revocable access suitable for calendar clients, where supported. Include instructions for subscribing in Apple Calendar and Google Calendar. If secure subscription is unavailable, provide a downloadable `.ics` file and explain that importing it is a snapshot and how to refresh it.
