---
title: The Trust Center and reporting a security problem
description: Where to read Rally's security and legal documents, and how to report a vulnerability.
nav_title: Trust Center
---

The earlier pages in this chapter are a summary. The documents behind them are
in Rally's Trust Center. This page lists what is there, then covers how to
report a security problem and what to hand your IT team when they ask about
Rally.

## The Trust Center

Everything is at [rallywith.ai/trust](https://rallywith.ai/trust/). It is
public: you do not need a Rally account, a non-disclosure agreement or a
request form to read any of it.

| Document | What it is for |
| --- | --- |
| [Overview](https://rallywith.ai/trust/) | The front page, linking to everything below. |
| [Security](https://rallywith.ai/trust/security/) | The security controls in Rally today, and how to report a problem. |
| [Terms of Service](https://rallywith.ai/trust/terms/) | The agreement for using Rally. |
| [Privacy Policy](https://rallywith.ai/trust/privacy/) | How personal information is collected, used, kept and deleted. |
| [Acceptable Use](https://rallywith.ai/trust/acceptable-use/) | What Rally may and may not be used for. |
| [Data Processing Addendum](https://rallywith.ai/trust/dpa/) | The contract terms for how Rally processes your Organization's data. |
| [Sub-processors](https://rallywith.ai/trust/subprocessors/) | The outside companies that handle data for Rally. |
| [Cookie & Tracking Notice](https://rallywith.ai/trust/cookies/) | What Rally's public website and the Mac app store on your device. |

Each document carries its own date, so you can tell when it last changed.

A few things people often ask:

- Certifications. Rally does not claim a security certification. The
  Security page lists the controls that exist in the product today, and says it
  will add independent assurance only once it is complete and current.
- The public website. rallywith.ai uses no advertising trackers and sets no
  analytics cookie. It does keep its own simple count of page visits and
  downloads, which can store a random, anonymous identifier in your browser.
  The Cookie & Tracking Notice describes exactly what it records.
- Questions. Security, privacy, contract and procurement questions all go
  to help@rallywith.ai. Say which Organization you mean, and do not send
  passwords or customer content.

## Reporting a security problem

If you think you have found a security weakness in Rally, please tell us.

1. Email **help@rallywith.ai** with the subject **Security report**.
2. Describe:
   - **the affected surface**: which part of Rally (the Mac app, the
     browser version, the website or a particular feature);
   - **the impact**: what someone could do by exploiting it;
   - **steps to reproduce it**, precise enough for someone else to follow;
   - **a safe proof of concept**, showing the problem without causing harm.
3. Do not include credentials or full customer content, even your own. A
   description and a harmless example are enough.

While you investigate:

- Use only accounts and Organizations that you own or have permission to test.
- Do not access anyone else's data. If you come across sensitive information,
  stop.
- Do not disrupt the service, use social engineering, or run destructive or
  high-volume tests.

## A checklist for your IT team

If someone at your company is reviewing Rally, here is the chapter in short,
with a link to each point in full.

- **Signing in.** Google sign-in. A saved sign-in renews with use, lapses after
  30 days without use and lasts at most 90 days. Signing out ends it on the
  server as well as the Mac. See
  [Signing in, signing out and Lockdown mode](01-signing-in-and-out.md).
- **Saved sign-in on the Mac.** Encrypted by default; with **Lockdown mode** it
  is protected by the Mac's keychain instead. Same page.
- **Usage reporting.** The **Product analytics** switch controls detailed usage,
  error and crash reports; content-free reliability signals always continue.
  See [What Rally shares, and with whom](02-what-rally-shares.md#the-product-analytics-switch).
- **AI and outside providers.** The model sees only the context a task needs;
  connector credentials never go into prompts; customer content is not used to
  train a general-purpose model of Rally's own. The provider list is public,
  with 15 days' notice of changes. See
  [What Rally shares, and with whom](02-what-rally-shares.md#the-outside-companies-that-help-run-rally).
- **Data location.** A single Global deployment; no regional choice. See
  [Where your data lives](02-what-rally-shares.md#where-your-data-lives).
- **Desktop app protections.** Sandboxed windows, blocked unexpected navigation
  and pop-ups, isolated exports, short-lived signed passes for live
  connections, encrypted connector credentials. See
  [Protections that work without you](02-what-rally-shares.md#protections-that-work-without-you).
- **Retention.** Work is kept until deleted; archiving hides but does not
  erase; deletion is requested at help@rallywith.ai. See
  [What Rally keeps, and deleting your data](03-what-rally-keeps.md).
- **Tool approvals.** Rally does not stop to ask before each tool it uses, by
  design. What it can reach is decided by the connections you set up; see
  [How Rally works](../04-working-with-rally/01-how-rally-works.md).

That is the end of the chapter, and nearly the end of the book. The last
chapter is for the days when something does not work as it should.
