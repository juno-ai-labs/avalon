---
name: "Legal docket"
description: "Track every legal request by whose turn it is, and for how many days."
icon: "scale"
color: "indigo"
tags:
  - legal
connectors:
  - google-mail-and-calendar
---

Build a docket of open legal requests in this Canvas from my email. If Gmail is not connected yet, tell me how to connect it, then carry on. Ask only for what you cannot work out from the mail. “Which requests should count: contract reviews, NDAs, anything sent to legal?” and “Which domains are colleagues, and which are the other side?”

Make one numbered line per matter. Show the matter, who asked for it, its stage, whose turn it is, and for how many days. A matter is always with exactly one of three: legal, the business, or the other side. Read each whole thread, my replies included. When an email passes the turn, such as answers from the requester or comments from the other side's counsel, move the matter and start its day count again. Above the list, count the open matters and how many sit with each of the three. Link every line to its thread.

Track requests only. Do not review, summarize or give an opinion on any contract, and go by what each email says and the names of its attachments.

Fill the docket from recent mail now and attach a Sidekick that updates it as new mail arrives. Use an incoming-mail trigger if the connection supports one. If it only supports scheduled checks, state the actual refresh cadence. If I name teammates whose inboxes should feed the same docket, say what each of them needs to do and show whose inbox each matter came from. Keep the docket within this Canvas's audience.
