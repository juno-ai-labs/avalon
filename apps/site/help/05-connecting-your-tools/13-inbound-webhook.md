---
title: Inbound webhook
description: Send activity into Rally from any system that has no ready-made connector.
---

Not every tool your team uses has a card in Settings. If yours can send a web request when something happens, an inbound webhook lets it tell Rally anyway. This page leans a little technical, and is written for whoever on your team sets up that other system.

A webhook is a web address that one system calls to tell another that something happened. Rally gives you the address and a secret, you put both into the other system, and from then on each event it sends arrives in Rally as activity. That activity can start a Sidekick. Your alerting tool, an internal admin panel, a form service: anything that can send a signed web request will do.

## Creating one

Both kinds of connection are offered. **Connect for me** makes a webhook whose events are about you and come to you. **Connect for organization** (owners and administrators) makes one for the whole Organization.

1. Open **Settings → Connections** and find the **Inbound webhook** card.
2. Click **Connect for me** or **Connect for organization**. The **Create inbound webhook** dialog opens.
3. Give it a **Name** of up to 180 characters, so you can tell it apart later.
4. Optionally, fill in **Allowed event types**, separated by commas or spaces, such as `ticket.updated, incident.created`. Leave it empty to accept any event type.
5. Click **Create webhook**.
6. Copy the **Endpoint** (the address) and the **Signing secret** straight away, with **Copy endpoint** and **Copy secret**.

> [!WARNING]
> Rally shows the signing secret once and never again. Put it straight into the sending system's protected settings. Never paste it into a chat, a Canvas, an email or a support message: anyone with the secret can send Rally events that look genuine.

You can create as many inbound webhooks as you need. One for each sending system keeps things tidy.

## What the sender has to do

The sender posts a JSON object (a block of structured text) to the endpoint, and signs each request with the secret, so Rally knows it came from someone who holds it. The signature goes in a header called `X-Rally-Signature`:

```text
X-Rally-Signature: t=<unix-seconds>,v1=<hex HMAC-SHA256 of "<unix-seconds>.<raw body>">
```

In words: take the current time in Unix seconds, put a full stop after it, add the exact bytes of the request body, and compute an HMAC-SHA256 of that with the signing secret. Send the time as `t` and the result, in hexadecimal, as `v1`. The dialog shows the same format. Rally rejects a request whose time is more than five minutes away from its own clock, so keep the sender's clock accurate.

Give each event a stable ID and an event type in the body. If the body names an event type that is not in **Allowed event types**, Rally turns it away.

## What the sender hears back

| Response | Meaning |
| --- | --- |
| `202` | Accepted. A new event. |
| `200` | Rally already has this event. Nothing more to do. |
| `400` | The body is not valid: not a JSON object, or a field is wrong. |
| `401` | The signature is wrong, or its time is more than five minutes off. Check the secret, how the signature is computed, and the sender's clock. |
| `409` | This event ID was already used for different content. |
| `413` | The body is too large. |
| `422` | The event type is not allowed for this webhook, or the event names someone who is not a member. |

If the request fails on the network, or Rally answers with a `5xx` error, the sender should try again later with the same body and the same ID. Do not reuse an ID for different content.

## Replacing the secret

If the secret is lost or might have leaked, an owner or administrator clicks **Refresh** on the webhook's row in **Settings → Connections**. Rally makes a new secret and shows it once. The old one stops working immediately, so update the sender straight away. The endpoint stays the same.

## How Rally treats what arrives

Rally has no way to check what an outside system says, so it treats the content of a webhook event as unverified. In particular, if an event claims something about a person, Rally does not take that as proof of who they are.

To have events do something, build a Sidekick that starts on them. [Triggers and schedules](../03-sidekicks/04-triggers-and-schedules.md) shows how.

## When delivery fails

1. Check the sender is using the current endpoint and secret.
2. Check the body is a JSON object and its event type is allowed.
3. Replace the secret only if the old one may be lost or exposed.

If you contact support, send the response code, roughly when it happened, your Rally region, the event type and any request ID you can see. Do not send the signing secret or the full event body.

Next, [Custom MCP server](14-custom-mcp-server.md).
