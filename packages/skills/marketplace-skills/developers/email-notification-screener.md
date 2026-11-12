---
name: "Email notification screener"
description: "Turn repeated email alerts into a ranked dashboard of issues."
icon: "inbox"
color: "orange"
tags:
  - developers
---

Build an issue dashboard in this Canvas from notifications delivered to my email. Ask me only for missing details. “Which connected mailbox or label should I watch?” and “Which tools or senders produce the alerts you want screened?” Read the matching notifications and use their subjects and content to identify actionable issues.

Group repeat alerts under one issue using the source's incident ID, issue link, or alert fingerprint when available. Update the existing issue with its latest status, last occurrence, count, and source links. Stack-rank open issues by impact and urgency, using recency to break ties. Show the reason for the rank and keep resolved issues out of the open queue.

Backfill the dashboard from matching email and attach a Sidekick to process new notifications as they arrive. Use an incoming-mail trigger if the connection supports one. If it only supports scheduled checks, state the actual refresh cadence. Keep the dashboard within this Canvas's audience and update the issue rows in place as each notification is processed.
