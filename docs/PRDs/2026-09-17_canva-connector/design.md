# Canva connector design

> Companion to [`prd.md`](prd.md). Holds the ingress, the event schemas, the
> trigger manifest, the workspace tool catalog, and the Sidekick trigger
> examples. Provider facts and their sources are in
> [`research.md`](research.md); nothing here re-argues them.

## 1. Shape of the connector

```
Canva MCP (mcp.canva.com/mcp) ── personal connection ── live tools/list ── model
Connect REST (api.canva.com)  ── workspace connection ── fixed tools ────── model
Connect webhooks (one URL)    ── workspace connection ── activity ───────── digests,
                                                                            watched
                                                                            work streams,
                                                                            Sidekick runs
```

| | Personal | Workspace |
| --- | --- | --- |
| Capability | `canva.personal.mcp` | `canva.workspace.design` |
| Credential | Canva MCP OAuth tokens (CIMD), per member | One administrator's Connect OAuth tokens |
| Tools | Live `tools/list`, never checked in | Fixed reviewed REST tools, this document |
| Activity | None | Webhook deliveries |
| Availability | Owner only | Every member of the Rally workspace |

`activityConnectionScopes: ["workspace"]`, as Granola's is: a personal
connection's designs never reach Rally as events, however they are watched.

## 2. The shared ingress

Canva's integration holds **one** redirect URI set and **one** webhook URL, for
every Canva user in every Canva team. Rally runs regional Workers. This is
precisely the constraint [`notion-ingress.md`](../../notion-ingress.md) already
solves, and Canva reuses that module's shape rather than inventing a second one:

- `canva.rallywith.ai` binds to the Global Worker and serves two routes:
  `GET /connections/canva/callback` and `POST /ingest/canva`.
- OAuth state is minted `<region>.<32 bytes of entropy>` through
  `region-routed-state.ts`, so the callback returns to the region that started
  the attempt.
- A `canva_connection_routes` directory in Global D1 maps
  `(canva_team_id, canva_user_id)` to the region and connection that owns it,
  written on a successful workspace authorization and deleted on disconnect.
- A delivery is verified at the ingress, routed by the directory, and forwarded
  to the owning region over the authenticated internal binding.

Two things differ from Notion and both simplify it. Canva's webhook secret is not
a per-tenant secret delivered in a setup handshake — it is Canva's public JWKS,
so the unsigned-challenge dance in
[`connectors.md`](../../connectors.md#unsigned-webhook-subscription-handshakes)
does not apply, and no plaintext ever needs clipboard rescue. And Canva's URL
carries no `setup=` parameter, because there is nothing to claim.

**One Canva integration serves all regions.** The alternative — one Canva
integration per region, each with its own URL and credentials — was rejected:
private integrations are bound to one Canva Enterprise team, the developer
account is a single administrative object, and a second registration doubles the
manual portal work that
[`connector-installation-lifecycle.md`](../../connector-installation-lifecycle.md)
already treats as the expensive part.

### Routing a delivery to a tenant

Every ingestible notification carries the recipient: `content.receiving_team_user`
(`user_id`, `team_id`). That pair is the only tenancy evidence in the payload, and
the ingress resolves it against the directory:

1. Verify the signature against the cached JWKS. Refetch keys only on an
   unrecognized `kid`. Unverifiable → `401`, no row written anywhere.
2. Check `created_at` against the freshness window (§7). Stale → `401`.
3. Parse the envelope. Unknown `content.type`, or a handled type that fails its
   schema → `400` naming the field, per
   [`naming-a-schema-failure.md`](../../naming-a-schema-failure.md).
4. Resolve `(team_id, user_id)` in the directory. No match → `404`
   `unrouted_delivery`, no row, no receipt. A Canva user who authorized the
   integration outside Rally is not a tenant, and the ingress must never guess
   one.
5. Claim the ingress receipt on `content`-level `id`. Already claimed → `200`.
6. Forward to the owning region, which normalizes and queues.

Steps 1–4 happen before any write. The ordering is the security property: an
unverified or unroutable delivery leaves no trace and reaches no workspace.

## 3. Which events Rally ingests

Canva offers no per-event subscription. Enabling `collaboration:event` enables all
eleven. The real decision is the disposition of each delivered type, and a
verified delivery naming a type Rally does not handle is refused with `400`
`unsupported_webhook_event` before the receipt — the rule Granola and Fireflies
already follow.

| `content.type` | Disposition | Why |
| --- | --- | --- |
| `comment` | **Ingest — digestible** | Someone asked the recipient something about a design. This is the event the connector exists for. |
| `design_mention` | **Ingest — digestible** | An explicit request for a named person's attention. |
| `suggestion` | **Ingest — digestible** | A proposed edit awaiting a decision. |
| `design_approval_requested` | **Ingest — digestible** | A named person is blocking a design until they act. |
| `design_approval_response` | **Ingest — digestible** | The requester learns their design is approved or rejected. |
| `share_design` | **Ingest — digestible** | A design arrived in the recipient's hands, often with a message. |
| `share_folder` | **Ingest — digestible** | As above, for a body of work. |
| `design_access_requested` | **Ingest — operational** | Real, and someone is blocked, but it is an access-control chore rather than something that happened to the work. It should be able to *trigger* a Sidekick without appearing in a digest. |
| `folder_access_requested` | **Ingest — operational** | As above. Also the only event requiring a write scope (`folder:permission:write`) to receive. |
| `design_approval_reviewer_invalidated` | **Ingest — operational** | A system-generated correction to an approval Rally already reported. It must not be swallowed by the approval event it follows, and it is not itself news. |
| `team_invite` | **Refuse** | It names no design and no folder, so it has no Rally resource, cannot narrow a rule, and cannot be watched. It is Canva account administration, and the recipient is frequently not a Rally member at all. Refused as `unsupported_webhook_event`. |

Per [`connector-digestibility.md`](../../connector-digestibility.md), the seven
digestible types each get a row there in the same change.

`comment`, `design_mention` and `suggestion` overlap by design in Canva: a
suggestion-typed thread mentioning someone can produce more than one
notification. They carry distinct notification `id`s, so they dedupe
independently — deliberately, and for the reason Fireflies' two meeting events
keep distinct dedupe keys: the later one must not be swallowed by the earlier.

## 4. Normalized activity

One `CanvaNotificationSchema` discriminated on `content.type`, built from the
shapes in [`research.md`](research.md#the-eleven-event-types). Every field Canva
marks optional is optional in Rally's schema — including all three of
`TeamUser`'s, which means the routing pair in §2 is *validated*, not assumed, and
its absence is a refusal rather than a crash.

```ts
const TeamUser = z.object({
  user_id: z.string().min(1).optional(),
  team_id: z.string().min(1).optional(),
  display_name: z.string().min(1).optional(),
});

const DesignSummary = z.object({
  id: z.string().min(1),
  urls: z.object({ edit_url: z.string().url(), view_url: z.string().url() }),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  title: z.string().optional(),
  url: z.string().url().optional(),
  thumbnail: z.object({
    width: z.number().int(), height: z.number().int(), url: z.string().url(),
  }).optional(),
  page_count: z.number().int().optional(),
});

const FolderSummary = z.object({
  id: z.string().min(1),
  name: z.string(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  url: z.string().url().optional(),
});

const CanvaNotification = z.object({
  id: z.string().min(1),
  created_at: z.number().int(),
  content: z.discriminatedUnion("type", [
    CommentContent, DesignMentionContent, SuggestionContent,
    DesignApprovalRequestedContent, DesignApprovalResponseContent,
    DesignApprovalReviewerInvalidatedContent,
    ShareDesignContent, ShareFolderContent,
    DesignAccessRequestedContent, FolderAccessRequestedContent,
    TeamInviteContent,
  ]),
});
```

`TeamInviteContent` is in the union so the parse succeeds and the refusal names
the event rather than a field — a refusal that reads `unsupported_webhook_event:
team_invite` is diagnosable; one that reads "invalid discriminator" is not.

Every provider-controlled string is capped, and the cut reported through a
`truncated` flag, as Fireflies' are. Comment `plaintext` and `markdown` are the
strings that actually run long.

The normalized activity:

| Field | Value |
| --- | --- |
| `provider` | `canva` |
| `providerEventId` | `id` (the notification id — Canva supplies one, so nothing is derived) |
| `eventType` | `content.type`, verbatim |
| `resourceType` | `canva_design`, or `canva_folder` for the two folder events |
| `providerResourceId` | `content.design.id` or `content.folder.id` |
| `actor` | `triggering_user`, absent on `design_approval_reviewer_invalidated` |
| `subject` | `{ id, type }` of the design or folder |
| `occurredAt` | `created_at` × 1000 |
| `title` | e.g. `"Comment on \"Q4 launch deck\""`, falling back to the design id when `title` is absent |
| `textSnippet` | bounded `content.comment.thread_type.content.plaintext`, or the `share.message`; empty otherwise |
| `visibility` | `{ scope: "workspace" }` |
| `targetUserIds` | the Rally member matched from `receiving_team_user`, when one matches; otherwise empty |
| `entityKeys` | `canva:design:<id>` or `canva:folder:<id>`, plus `canva:team:<team_id>` |
| `dedupeKey` | the notification id |
| `metadata` | `commentEventType`, `threadType`, `approvalStatus`, `respondingGroupsExternal`, `mentionedTags` — the fields the filter leaves in §5 read |

**No hydration on the delivery path.** Unlike Granola and Fireflies, Canva's
payload already carries the design's title, URLs and thumbnail, so no provider
round trip is needed inside the acknowledgement window. `hydrateResource` re-reads
`GET /v1/designs/{id}` or `GET /v1/folders/{id}` when something later asks for
current state.

**Thumbnail URLs expire after 15 minutes and are never stored as a resource's
canonical URL.** `urls.view_url` is the canonical URL; the thumbnail is bounded
metadata that a reader must re-fetch through `hydrateResource`.

## 5. The trigger manifest

Rally's automation triggers are declared, not built: `activityTriggers` in the
connector manifest is what makes an event selectable by a Sidekick rule, by a
watched work-stream resource, and by the digest. Writing this block *is* the
trigger work.

```ts
activityTriggers: defineConnectorActivityTriggers(
  "Canva",
  {
    digestible: [
      "comment", "design_mention", "suggestion",
      "design_approval_requested", "design_approval_response",
      "share_design", "share_folder",
    ],
    operational: [
      "design_access_requested", "folder_access_requested",
      "design_approval_reviewer_invalidated",
    ],
  },
  { /* per-trigger definitions, below */ },
  [ /* shared filter fields, below */ ],
),
resourceTypes: ["canva_design", "canva_folder"],
supportsWatches: true,
supportsPolling: false,
supportsWebhooks: true,
```

**Event families** — the grouping a rule selects over:

| Family | Members |
| --- | --- |
| `canva.design.discussed` | `comment`, `design_mention`, `suggestion` |
| `canva.design.approval_changed` | `design_approval_requested`, `design_approval_response`, `design_approval_reviewer_invalidated` |
| `canva.design.shared` | `share_design`, `design_access_requested` |
| `canva.folder.shared` | `share_folder`, `folder_access_requested` |

**Shared filter fields**, declared once for every trigger:

| Key | Type | Source |
| --- | --- | --- |
| `actorUserId` | `string` | `triggering_user.user_id` or `.id` |
| `actorDisplayName` | `string` | `triggering_user.display_name` |
| `canvaTeamId` | `string` | `receiving_team_user.team_id` |
| `recipientPersonIds` | `person_id_array` | Rally people matched from `receiving_team_user` |

**Per-trigger definitions:**

| Trigger | Label | Family | Own filter fields | Resource relationship |
| --- | --- | --- | --- | --- |
| `comment` | Comment on a design | `canva.design.discussed` | `designId`, `designTitle` (`string`), `commentEventType` (`string`: `new`/`reply`), `threadType` (`string`: `comment`/`suggestion`), `mentionedTags` (`string_array`), `mentionedPersonIds` (`person_id_array`) | `design` → `canva_design` |
| `design_mention` | Mentioned in a design | `canva.design.discussed` | as `comment` | `design` → `canva_design` |
| `suggestion` | Suggestion on a design | `canva.design.discussed` | as `comment` | `design` → `canva_design` |
| `design_approval_requested` | Approval requested | `canva.design.approval_changed` | `designId`, `designTitle` | `design` → `canva_design` |
| `design_approval_response` | Approval answered | `canva.design.approval_changed` | `designId`, `designTitle`, `approvalStatus` (`string`), `respondingGroupIds` (`string_array`), `respondingGroupExternal` (`boolean`) | `design` → `canva_design` |
| `design_approval_reviewer_invalidated` | Approval reviewer invalidated | `canva.design.approval_changed` | `designId`, `designTitle` | `design` → `canva_design` |
| `share_design` | Design shared | `canva.design.shared` | `designId`, `designTitle`, `hasMessage` (`boolean`) | `design` → `canva_design` |
| `design_access_requested` | Design access requested | `canva.design.shared` | `designId`, `designTitle` | `design` → `canva_design` |
| `share_folder` | Folder shared | `canva.folder.shared` | `folderId`, `folderName`, `hasMessage` (`boolean`) | `folder` → `canva_folder` |
| `folder_access_requested` | Folder access requested | `canva.folder.shared` | `folderId`, `folderName` | `folder` → `canva_folder` |

A design is a container the way a Notion page is: comments, mentions,
suggestions and approvals happen *inside* it, and it persists across them. So
`canva_design` is a legitimate `automationBindableResourceTypes` entry and a rule
can say "this deck", not just "any deck". **Both declared types must actually
materialize as resources** — the connector writes a `canva_design` or
`canva_folder` row on every ingested delivery, from the summary the payload
already carries. Declaring a relationship whose type never materializes is the
Granola gap [`automation-lifecycle.md`](../../automation-lifecycle.md) names, and
Canva must not repeat it.

`respondingGroupExternal` is deliberately exposed: an approval answered by an
*external* group is the one approval a brand team most wants to hear about
immediately, and it is a boolean Canva already sends.

## 6. Workspace tool catalog

Fixed, reviewed, checked-in — the Granola/Fireflies workspace posture, not the
pass-through. Every tool carries capability `canva.workspace.design`, rejects
unknown fields, describes every parameter, and returns one provider page at a time
with the provider's cursor exposed. Model-facing names take Rally's normal
connector prefix.

### Reads

| Tool | Mode | Idempotency | Canva endpoint | Notes |
| --- | --- | --- | --- | --- |
| `list_designs` | read | safe | `GET /v1/designs` | `query`, `ownership`, `sortBy`, `cursor`. The discovery entry point: every design id in this catalog comes from here or from an event. |
| `get_design` | read | safe | `GET /v1/designs/{id}` | Title, URLs, thumbnail, page count. |
| `get_design_pages` | read | safe | `GET /v1/designs/{id}/pages` | Bounded page metadata. |
| `list_folder_items` | read | safe | `GET /v1/folders/{id}/items` | Designs, folders and images in a folder. |
| `get_folder` | read | safe | `GET /v1/folders/{id}` | |
| `list_brand_templates` | read | safe | `GET /v1/brand-templates` | Needs `brandtemplate:meta:read`. |
| `get_brand_template_dataset` | read | safe | `GET /v1/brand-templates/{id}/dataset` | **The prerequisite for autofill**: it names the fields and their types. |
| `get_comment_thread` | read | safe | `GET /v1/designs/{designId}/comments/{threadId}` | Resolves a thread id from a `comment` event. |
| `list_comment_replies` | read | safe | `GET /v1/designs/{designId}/comments/{threadId}/replies` | |
| `get_design_export_formats` | read | safe | `GET /v1/designs/{id}/export-formats` | What `export_design` may be asked for. |

### Writes

| Tool | Mode | Idempotency | Canva endpoint | Notes |
| --- | --- | --- | --- | --- |
| `create_comment_reply` | write | unsafe | `POST …/comments/{threadId}/replies` | Closes the loop on the event that opened it. Needs `comment:write`. |
| `create_comment_thread` | write | unsafe | `POST /v1/designs/{id}/comments` | |
| `create_design` | write | unsafe | `POST /v1/designs` | From a preset or an asset. |
| `create_folder` | write | unsafe | `POST /v1/folders` | |
| `move_folder_item` | write | unsafe | `POST /v1/folders/move` | |
| `autofill_brand_template` | write | job | `POST /v1/autofills` + poll | The highest-value write: a brand template plus a data object becomes a design. |
| `export_design` | write | job | `POST /v1/exports` + poll | Returns download URLs that **expire**; the tool returns them as transient and never as a stored resource URL. |
| `upload_asset_from_url` | write | job | `POST /v1/asset-uploads` + poll | Takes a URL, not bytes, so a Rally artifact reaches Canva without passing through a tool argument. |

Deliberately absent from v1: design imports, resizes, merges, analytics, asset
delete, folder delete, brand template publish. Each is a real API and none has a
named job to do yet; `list_designs` plus autofill plus export covers the
workflows §8 describes. Adding one later is a tool definition, not a redesign.

### The async job primitive

Six Connect families are create-then-poll with no idempotency key. Rather than
writing that loop eight times, the connector gets one internal helper —
`runProviderJob({ create, poll, terminal })` — and every job tool is a
declaration over it:

- One tool call creates the job and polls to a terminal state, returning the
  job's result.
- **The job id is in the output on every path, including timeout.** A tool that
  times out returns `job_in_progress` carrying the id, and the model's documented
  next action is to read that job, never to create a second one. Canva offers no
  idempotency key, so a blind retry of `autofill_brand_template` produces two
  designs — the error sentence has to say so.
- A poll ceiling and a backoff schedule bound it. **Both numbers are the team's
  to set**, per
  [`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md);
  they are listed as open questions in [`prd.md`](prd.md), not guessed here.
- A job that fails carries Canva's own failure reason through, named, not
  flattened to `handler_error`.

This is the one genuinely new building block Canva asks for, and it is generic:
the next provider with create-then-poll semantics declares against it.

### Failure vocabulary

| Canva condition | Rally code | Model's next action |
| --- | --- | --- |
| `401`, revoked or expired token | `unauthorized` → connection `needs_reconnect` | Stop; tell the person to reconnect Canva |
| `403`, scope not granted | `forbidden` | Stop; name the missing scope |
| `404` | `not_found` | Re-read the id from `list_designs` or the event |
| `429` | `too_many_requests` with the provider's wait | Retry once after `retryAfterMs` |
| Job `failed` | `provider_job_failed` with Canva's reason | Correct and retry, or stop |
| Poll ceiling reached | `job_in_progress` with the job id | Read the job; **do not create another** |
| Response over the cap | `payload_too_large` | Ask for less — a page range, one format |

The body is read before the status is trusted, which is the lesson Fireflies'
HTTP 500 carrying an auth error taught, and it is cheap to apply pre-emptively.

## 7. Limits to be set, not guessed

Each of these is a defensive limit, and
[`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md)
says the guard is written open and the number handed back:

- The webhook freshness window on `created_at`.
- The JWKS cache TTL, and the floor between two refetches on unrecognized `kid`
  (an unbounded refetch is a denial-of-service amplifier pointed at Canva).
- The job poll ceiling and backoff schedule.
- Page-size ceilings per read tool.
- The per-string cap before `truncated` is set, especially on comment text.

## 8. Triggers for Sidekicks

Nothing here is new machinery. Once the manifest in §5 exists, a Canva event
already reaches `WorkspaceDO.ingestConnectorEvent`,
`matchExternalEventDestinations` selects registrations by connection, connector
type, event type and activation boundary, applies the audience rule, evaluates
each predicate with no model inference, and `admitOccurrence` opens a run keyed
`external:<workspaceEventId>`. Declaring the triggers *is* the integration.

What a Sidekick then does with the workspace tools is the other half, and the two
compose:

**Suggestion triage.** Rule: `canva.design.discussed`, `matching`, with
`threadType equals suggestion` and `designId equals <the launch deck>`. The run
reads the thread with `get_comment_thread`, decides whether the suggestion
contradicts anything in the brand guidance it holds in `automation` memory, and
replies through `create_comment_reply`, posting its result into the work stream.

**Approval chaser.** Rule: `canva.design.approval_changed`, `matching`, with
`eventType equals design_approval_requested`. The run posts who is blocking what,
into the work stream that owns the campaign. A schedule trigger on the same
Sidekick re-checks and nudges — two triggers, one Sidekick, which is the shape
the trigger table already supports.

**External approval escalation.** Rule: `canva.design.approval_changed` with
`respondingGroupExternal equals true`. An outside party answering an approval is
the one case a brand team wants told immediately rather than digested.

**Access-request triage.** Rule: `canva.folder.shared` with `eventType equals
folder_access_requested`, narrowed to one `canva_folder`. The run names who asked
for what and, where the workspace has decided the policy, says whether it fits —
an operational event doing useful work without ever entering a digest.

**Launch kit (the tools as an action, not a trigger).** Rule: a *Linear* project
status change. The run calls `get_brand_template_dataset`, then
`autofill_brand_template` with the release's fields, then `export_design`, and
posts the exported assets into the work stream. Canva is the hands here, not the
ears — which is the point of shipping tools and triggers in one connector rather
than two.

A rule may narrow itself to one `canva_design` or one `canva_folder` because §5
declares those relationships and §4 materializes them, so `resources_search`
returns something and the drafting model is not told that Canva "cannot be bound".
