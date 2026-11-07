---
title: What Rally shares, and with whom
description: The product analytics switch, the outside companies that help run Rally, and where your data lives.
nav_title: What Rally shares
---

Only part of Rally runs on your Mac. Most of the work happens on Rally's
servers and with a handful of outside companies that provide the hosting, the
AI models, email and web search. This page covers what information goes
where, and the one switch you control on your own Mac.

## The Product analytics switch

The desktop app can report how it is used and when it goes wrong, which is how
the Rally team finds bugs and learns which features people rely on. You decide
how much of that is sent.

### What it sends when it is on

Open **Settings → Application** and look under **Privacy & diagnostics**. The
**Product analytics** switch is on unless you turn it off. While it is on,
Rally shares:

- Product usage: which features you use and when, described as events such
  as opening a Canvas, not as the contents of what you wrote.
- Error reports: details of errors in the app, cleaned of sensitive
  information first, with a short trail of the steps that led up to the error.
  Rally calls these steps *breadcrumbs*.
- Crash reports: the technical record macOS produces when the app crashes.

These reports can include your name and email address as they appear on your
verified account, so the Rally team can contact you about a problem you hit.

### What still happens when it is off

Turn the switch off and the detailed reporting above stops. Rally still sends a
small set of essential reliability signals, such as whether the app could
connect. They carry no content from your conversations or files. Rally needs
them to keep the service working, and they cannot be turned off.

### Things to know about the switch

- It follows your account. The choice is saved to your Rally account and
  applies on your other devices too. While Rally is saving it you see
  **Waiting to sync this account preference.**
- Turning it off takes effect at once on this Mac. Crash reports stop being
  sent for the rest of this launch, and the page says **Crash upload has
  stopped for this launch. Restart Rally to remove local native crash dumps and
  apply the current setting.** Restart Rally when convenient to clear out any
  crash reports already saved on the Mac.
- Turning it back on is confirmed first. Rally checks with its servers
  before it starts sending again. If it cannot confirm, the setting stays off.
- It lives in the Mac app. Where Rally cannot change the setting, the switch
  is greyed out and you see **Product analytics is managed in the Rally desktop
  app.**

> [!NOTE]
> The switch controls what the desktop app reports about your use of it.
> Rally's servers also keep their own operational logs and traces, sent to the
> analytics provider listed below. The public Sub-processors list says those
> traces can include Canvas and Sidekick names, descriptions and message previews.

## The outside companies that help run Rally

A company that processes your data on Rally's behalf is called a
*sub-processor*. Rally publishes the full, current list on the
[Sub-processors](https://rallywith.ai/trust/subprocessors/) page of the Trust
Center. At the time of writing it names these:

| Company | What it does for Rally |
| --- | --- |
| Cloudflare | Hosting: the servers, databases, file storage and network that Rally runs on. |
| OpenRouter | Passes requests from Rally to the AI model providers below. |
| xAI | The main AI model that does Rally's thinking, reached through OpenRouter. |
| Google | AI models for sorting and structuring tasks; also Google sign-in and your Google tools when you connect them. |
| Anthropic | A backup AI model, used when needed. |
| Microsoft (Azure) | Dictation and transcription, only when that feature is turned on. |
| PostHog | Product analytics, and Rally's server logs and traces. |
| Resend | Email: invitations, notifications and mail sent to Sidekicks. |
| Firecrawl | Web searches and page reading that you or a task ask for. |

Treat the Trust Center page as the authority, not this table. Rally updates
that page at least 15 days before a new sub-processor starts handling customer
personal data, except in an urgent security or availability case. If your
Organization has signed Rally's Data Processing Addendum, it can object during
that notice period by writing to help@rallywith.ai.

The tools you connect yourself in
[Chapter 5](../05-connecting-your-tools/index.md), such as Gmail, GitHub,
Linear, Notion and Slack, are listed separately. Rally sends data to them
because you told it to, and they are your own suppliers, not Rally's.

## What the AI model sees

To do a task, Rally sends the model the part of the work it needs: your
request, the relevant parts of the conversation and files, the results of the
tools it has used so far, and its instructions. Nothing else from your
Organization goes along.

The keys and passwords that let Rally reach your connected tools never go to
the model. They are stored encrypted and kept out of everything the model
reads.

Rally does not use your content to train a general-purpose model of its own,
and it does not sell personal information.

Each model provider handles the data under its contract with Rally, and how
long a provider keeps a request can vary between providers. For that reason the
Privacy Policy asks administrators to keep unnecessary sensitive information
out of requests. If a document is not needed for the job, do not attach it.

## Where your data lives

Every Organization lives in Rally's single **Global** deployment, which has its
own databases, storage and encryption keys. There is no region to choose and
nothing to set.

Some processing happens outside that deployment: the AI and email providers
above, the networks that deliver data to you, and the tools you connect all
run on their own infrastructure, in their own locations. Where the law
requires it, Rally uses recognized safeguards for international transfers,
such as the European Commission's Standard Contractual Clauses. If your
organization needs the transfer paperwork, ask at help@rallywith.ai.

Rally does not currently offer a separate European or other regional
deployment, so do not plan on your data being kept in one particular country.

## Protections that work without you

Some of Rally's security happens automatically in the Mac app. There is
nothing to set, but your IT team may ask about it.

- Each window is fenced off. The parts of Rally that display content run in
  a restricted sandbox and cannot reach your Mac's system directly.
- Unexpected pages are blocked. If something inside a Rally window tries to
  send it to an unexpected web address, or to open a pop-up, Rally refuses.
- Exports are made in isolation. When you save a message as an image or PDF
  (see [Saving and sharing what Rally wrote](../06-things-rally-makes/05-saving-and-exporting.md)),
  Rally draws it in a separate, hidden window set aside for that job.
- Live connections use short-lived passes. The connection that streams new
  messages to you uses a signed pass that expires quickly and works only for
  what it was issued for.
- Your connections' keys are encrypted. The credentials for your connected
  tools are stored encrypted on Rally's servers and are blanked out of Rally's logs.

These describe controls that exist in Rally today. They are not a security
certification, and Rally does not claim one. The
[Trust Center](04-trust-center-and-security-reports.md) has the full list.
