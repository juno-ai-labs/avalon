# Clockwork Recruiting — API investigation

> Investigated 2026-09-17, for
> [the Clockwork connector PRD](prd.md).
>
> **Clockwork's developer documentation is not public.** Everything recorded
> here is reconstructed from sources that _are_, and each claim below is marked
> with how it was established. Nothing in this file is a quotation from a
> document Rally has been given.

## How this was established, and how far to trust it

| Source | What it is | What it proves |
| --- | --- | --- |
| [Pipedream's `clockwork_recruiting` component](https://github.com/PipedreamHQ/pipedream/tree/master/components/clockwork_recruiting) | Open-source integration code and a checked-in sample webhook delivery | Base URL, auth headers, several endpoint paths, the webhook create/delete calls, and **one real payload shape** |
| [Zapier's Clockwork app page](https://zapier.com/apps/clockwork-recruiting/integrations) | Published trigger/action/search inventory | The **resource model** — which entities exist and which are readable, writable and searchable |
| [Clockwork's integrations guide](https://support.clockworkrecruiting.com/article/528-clockwork-integrations-guide) | Public knowledge-base article | That every firm has API access at no extra cost, and that the developer documentation is obtained by writing to `support@clockworkrecruiting.com` |
| [Clockwork's API & integrations category](https://support.clockworkrecruiting.com/category/1275-api-integrations) | Public knowledge-base index | That articles exist for _How to Create API Keys_ and _API Gateway Limits_ — the bodies are not publicly readable |
| [API terms of use](https://www.clockworkrecruiting.com/api-terms-of-use) | Public terms | That call-volume limits exist and are published only in the private developer documentation |
| Live HTTP probes of `api.clockworkrecruiting.com` | Unauthenticated requests, 2026-09-17 | The host answers `{"message":"Forbidden"}` and `{"message":"Missing Authentication Token"}` — **AWS API Gateway's own error bodies**. There is no public OpenAPI or Swagger document at any conventional path. |

Treat the first row as strong: it is working code with a real sample payload.
Treat the second as a reliable inventory of _entities_ and a weak one about
_transport_ — Zapier does not say which of its triggers are webhook-backed and
which it polls for. Treat everything marked **unconfirmed** below as a question
for Clockwork's integrations team, not as a fact to build against.

## Authentication and base URL

**Confirmed.** Every request is:

```
https://api.clockworkrecruiting.com/v3.0/{firmSlug}/{path}

Authorization: Token <base64(apiKey + ":" + apiSecret)>
X-API-Key: <firmServiceKey>
```

Four separate values are needed, and they are not interchangeable:

| Value | What it identifies |
| --- | --- |
| `firmSlug` | The firm's Clockwork tenant, in the URL path (Pipedream calls it `firm_name`) |
| `apiKey` / `apiSecret` | The credential pair, base64-joined into a `Token` scheme — **not** HTTP Basic, despite the identical encoding |
| `firmServiceKey` | A second firm-level key sent in `X-API-Key`, distinct from `apiKey` |

There is **no OAuth**: no authorization endpoint, no consent screen, no refresh
token, no per-user grant. A Clockwork credential is a firm-wide secret held by
whoever administers the firm's Clockwork account.

## The resource model

**Confirmed** (paths exercised by Pipedream's code):

- `GET /people`, `POST /people`
- `POST /people/{id}/addresses`, `/email_addresses`, `/phone_numbers`,
  `/linkedin_urls`, `/positions`, `/tags`
- `GET /companies`, `GET /regions`, `GET /tags`
- `POST /webhooks`, `DELETE /webhooks/{id}`

All list endpoints take `limit` and `offset`; Pipedream uses `limit=100`, which
is its own choice and not evidence of the provider's maximum.

**Strongly implied** by Zapier's inventory, paths unconfirmed: `projects`,
`candidacies`, `candidacy_statuses`, `schools`, `users`, `note_categories`,
`firm_fields`, and per-person `notes`, `attachments`, `compensation`,
`education`, `websites`, `profile_picture`, `custom_fields`. Zapier also
publishes project sub-resources — `clients`, `locations`, `payments`, `users`,
`fees`, `compensation`, `attachments`, `custom_fields` — and a `People Search`
operation that takes arbitrary search parameters.

The shape that matters for a connector design is this: **Clockwork is a
person-centric graph with a project overlay, joined by a `candidacy`.** A
_person_ is a durable record with a dozen sub-resource collections hanging off
it. A _project_ is one executive search. A _candidacy_ is one person's
participation in one project, and it carries the state the firm actually
manages — a status, a rank, a stoplight, and pointers to three notes.

## Webhooks

**Confirmed.** Registration is `POST /webhooks` with a body of exactly:

```json
{ "hook_url": "https://…" }
```

and the response carries an `id` used by `DELETE /webhooks/{id}`.

Three consequences follow from that body, and each one shapes the design:

1. **There is no event-type subscription.** The request names a URL and nothing
   else, so a registered endpoint receives whatever Clockwork decides to send
   it. A receiver filters on arrival; it cannot narrow at registration.
2. **There is no signing secret.** Clockwork neither accepts one nor returns
   one, so a delivery carries no HMAC for the receiver to check. Nothing in
   Pipedream's source reads a signature header, and no knowledge-base article
   mentions one.
3. **There is no listing or inspection call.** `POST` and `DELETE` are the
   whole surface. A receiver that loses the `id` cannot enumerate its own
   registrations.

### The one confirmed payload

Pipedream's checked-in `test-event.mjs` — a sample delivery, so a real shape:

```json
{
  "event_name": "candidacy_updated",
  "candidacy": {
    "id": "…-uuid-…",
    "person_id": "…-uuid-…",
    "project_id": "…-uuid-…",
    "status_id": "…-uuid-…",
    "created_user_id": "…-uuid-…",
    "rank": 14,
    "stoplight_status": "red",
    "color_category": null,
    "assessment_note_id": null,
    "next_steps_note_id": null,
    "overview_note_id": null,
    "created_at": "2023-10-02T15:52:27Z",
    "updated_at": "2023-10-02T15:54:34Z",
    "updated_at_display": "2023-10-02T15:54:32Z"
  }
}
```

The envelope is `{ event_name, <resource_name>: { … } }`. The resource key is
named after the resource, not a generic `data`, which means **a new event type
brings a new top-level key** rather than a new value in a discriminated field.

Note what the payload does _not_ contain: no person name, no project name, no
status name, no firm identifier, no delivery id, no timestamp of its own beyond
the record's `updated_at`, and no statement of which fields changed. Every
identifier is a UUID that means nothing without a second call. **A Clockwork
delivery is a change signal and nothing more.**

### What other events exist — unconfirmed

Pipedream handles `candidacy_updated` and ignores everything else, which tells
us other deliveries arrive but not what they are named. Zapier publishes
triggers for _New Candidacy_, _Updated Candidacy_, _Candidate Status Change_,
_New Person Record_ and _Update Person Record_, and Zapier does not say which
are webhook-backed. Following the `<resource>_<verb>` convention of the one
confirmed name, the plausible set is `candidacy_created`, `person_created`,
`person_updated` and possibly `project_created` / `project_updated` — **a guess
from a naming convention, which is not a basis for shipping a subscription.**

The honest reading: one event name is known, an unknown number of others exist,
and a receiver must be built to refuse a name it does not recognize rather than
to assume a closed set. That is the opposite of the Ashby design, where a
documented catalogue of 27 event types could be enumerated in advance.

## Rate limits

**Unknown, deliberately.** The knowledge base has an _API Gateway Limits_
article whose body is not publicly readable, the API terms say limits are
published in the private developer documentation, and the host's error bodies
identify it as AWS API Gateway — which throttles by default. So limits exist,
their numbers are not obtainable from here, and
[`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md)
says not to invent one.

## Model Context Protocol

**Clockwork publishes no MCP server.** There is no first-party endpoint, no
entry in the Model Context Protocol servers registry, and no mention of MCP
anywhere in Clockwork's own site or knowledge base.

What a search does surface is four re-brokers, each of which wraps the same
REST API and presents it over MCP: [Zapier's Clockwork MCP
server](https://zapier.com/mcp/clockwork-recruiting),
[viaSocket](https://viasocket.com/mcp/clockwork-recruiting), Pipedream Connect,
and Membrane. All four work the same way: the firm's API key and secret are
handed to the broker, the broker holds them, and the broker's MCP server acts
on the firm's behalf.

That is a materially different trust proposition from Ashby's, Granola's,
Fireflies' or Slack's hosted MCP servers, each of which is **the provider's own
server holding a grant the provider issued**. A re-broker is a third party
Rally would be asking a customer to trust with a firm-wide recruiting
credential, in exchange for a tool surface Rally can author directly against the
same REST API. See the PRD's non-goals.

## Open questions for Clockwork's integrations team

These are the questions that would be put to `support@clockworkrecruiting.com`,
in the order they change the design:

1. **What is the complete set of `event_name` values a registered webhook
   receives?** Is `candidacy_updated` one of five or one of fifty?
2. **Is a delivery authenticated at all** — a signature header, a shared
   secret, a mutual-TLS option, anything? If not, is a per-registration secret
   on the roadmap?
3. **Can a registration narrow itself to event types or to a project**, or is
   every registered URL firm-wide and all-events?
4. **Is there a `GET /webhooks`?** Without one, a lost registration id is
   unrecoverable and duplicate registrations are undetectable.
5. **What are the published rate limits**, and does a throttled response carry
   a `Retry-After`?
6. **Does a delivery carry a stable delivery id** for idempotency, or is the
   `(resource id, updated_at)` pair the only replay anchor?
7. **What are the exact paths** for projects, candidacies and candidacy
   statuses, and does `GET /people` support a server-side search parameter or
   only offset pagination?
8. **Does the API distinguish read-only credentials from read-write ones?** A
   connector that only reads should be asking for a credential that only reads.

Questions 1 and 2 are the ones that gate the design. The PRD is written so that
a bad answer to either narrows the connector rather than blocking it.
