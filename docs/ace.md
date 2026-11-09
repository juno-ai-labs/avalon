# Ace internal administration

Ace is Rally's internal administration Worker at
`https://ace.internal.rallywith.ai`. It provides Access request review,
workspace administration, and a read-only view of Cloudflare
Queue dead letters. New internal pages extend the same Hono application and
component library. Product flags and model routes are configured in code and
optional API environment variables; see [`feature-flags.md`](feature-flags.md).

The **Access** page lists Global pre-workspace email requests and acknowledgement
state, issues timed or single-use download grants, and copies private download
links. [`private-access.md`](private-access.md) owns that workflow.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/ace/src/index.ts` | Hono routes, Access admission, same-origin writes, and static assets |
| `apps/ace/src/access.ts` | Shared signed Cloudflare Access assertion verifier |
| `apps/ace/src/directory.ts` | Read-only user and workspace search across configured regional D1 databases |
| `apps/ace/src/regional-api.ts` | Regional operator client with shared response contracts |
| `apps/ace/src/client/workspaces.tsx` | Workspace lookup, plan changes, and retirement |
| `apps/ace/src/cloudflare-queue-admin.ts` | Active dead-letter discovery, metrics, and non-consuming message peeks |
| `apps/ace/src/client/components/ui.tsx` | Shared controls and panels |
| `apps/ace/src/client/main.tsx`, `styles.css` | Application navigation and visual system |
| `apps/ace/scripts/deploy.mjs`, `.github/workflows/deploy-ace.yml` | Access provisioning, Worker/assets deployment, and runtime secrets |

## How it works

Cloudflare Access authenticates the operator before Ace. The Worker independently
verifies the signed `Cf-Access-Jwt-Assertion`, issuer, and Ace's audience. Deploy
copies the migration site's policies and identity providers into Ace's separate
Access application. The default page is Access; Queues and Workspaces
are the other navigation entries.

**Workspaces.** The tab searches configured deployments' directories and retires the
selected workspace in the region that owns it, through
`POST /api/workspaces/:id/retire`, which relays to the regional API's
`/internal/workspaces/:id/retire` over that region's operator credential
(code-facing `requireAceOperator` and `ACE_OPERATOR_ROLE`; stored as the secret
`DEMO_OPERATORS_JSON` and the role `demos`, names kept from the removed Demos
tab because renaming them is a secret rotation in every region),
same-origin. The confirmation is the operator typing or pasting the workspace
id — the button stays disabled until it matches — and the id travels with the
request, where Ace and the regional API each refuse a confirmation that names
another workspace. The form says every Canvas, Sidekick and socket in the
workspace closes. The receipt says what closed, what stayed in an outbox, and
what remains when the walk could not finish, which a second retirement returns
to. It counts the parents as Canvases, Sidekicks, Channels and Threads and
names each failed node by the label for its recorded kind (`canvas`,
`automation`, `space`, `workstream`): the last two stay because the walk also
closes what the retired surfaces left in the `spaces` and `workstream`
storage, which held Channels and Threads
([`workspace-retirement.md`](workspace-retirement.md)). An incomplete pass keeps the typed id and the button armed, under the
counts and the failed nodes, so the next click returns to what remains. A
failed directory search is shown as a failure, never as "no matches"; a region
whose directory did not answer is named beside the rows the other returned;
the search matches an id as well as a name or slug; and a workspace the tab has
retired stays marked for the rest of the session — the mark is held in the app,
so it survives a switch to another tab — because the directory it searches does
not know. A regional refusal reaches the page as the API's own code and
message, and an answer the shared contract refuses is named
`regional_api_contract_mismatch` rather than read as an outage, with the
field the contract refused in the message — which says whether Ace or the
regional API is the one behind.

The same tab sets the selected workspace's plan, Starter or Growth, through
`POST /api/workspaces/:id/plan`, which relays to the regional API's
`/internal/workspaces/:id/plan` over the same credential. The new weekly quota
applies to the current week at once, and the regional API refuses a workspace
another region owns. The directory search returns each workspace's current
plan, and reads a region whose `workspaces` table has no `plan` column yet as
Starter: Ace deploys apart from the API, so it can reach a region before
migration 0118 has run there. [`usage-metering.md`](usage-metering.md) owns what a plan means.

`GET /api/queues/dead-letters` lists account Queues through Cloudflare's REST
API. A Queue is classified as a dead-letter queue only when a live consumer's
`dead_letter_queue` field points to it; Ace does not infer operational meaning
from an `-dead-letter` name. It then calls the per-Queue metrics endpoint for
the realtime `backlog_count`, `backlog_bytes`, and oldest message timestamp.
Selecting one calls `POST .../messages/peek` for one provider-defined batch.
Cloudflare publishes no maximum for peek's optional `batch_size`, so Ace does
not invent one. Peek does not lease, acknowledge, retry, or remove a message.
Ace deliberately discards Cloudflare's returned purge reference, so this first
Queues surface has no delete capability.

## Invariants

- Access policy lives in Cloudflare Access; application code verifies provenance.
- Mutations require the Ace page's origin before parsing or contacting a service.
- Workspace changes reach the regional API that owns the workspace.
- Queue identity comes from the returned resource ID and active consumer
  relationship; the peek route cannot inspect an arbitrary account Queue ID.
- Cloudflare's purge reference never reaches the client. Peek does not delete.
- Ace has no feature-flag or model-route management endpoint or RPC entrypoint.

## Boundary

Ace owns operator UI and its relays, Global Access intake review and download
grants, directory lookup, and read-only Queue inspection. Regional Workers own
product state, Durable Objects, and their access rules. Deployment-wide feature
configuration lives in the API constants and optional environment overrides.

## Failure modes and limits

Missing or invalid Access configuration returns 403. Local bypass requires both
`APP_ENV=development` and `ACE_DEV_AUTH=true`. Cross-origin mutations return 403.
Regional refusals retain their code and message; unavailable directories show an
outage rather than an empty search. Queue metrics are best effort and may be
approximate; a failed metrics request leaves the Queue visible as unavailable.
Cloudflare's peek API has no cursor, so the UI shows one provider-defined batch.

## Testing

`pnpm --filter @rally/ace test` covers Access admission, same-origin writes,
directory queries, Queue discovery/metrics/peek, operator relays, and the pages.
The retired flag/model endpoints return 404. Directory tests use real SQLite;
external HTTP APIs use typed capability doubles. The Workspaces suite
cover receipts, polling, offline state, typed confirmations, and regional errors.
`pnpm --filter @rally/ace typecheck` checks browser and Worker programs.
`pnpm --filter @rally/ace build` builds the browser bundle and dry-runs Wrangler.
Use explicit browser fixtures for visual checks of the operator pages.

## Regional impact

Workspace changes use that workspace's regional
API. Directory searches read identity data across configured deployments.

## Security and trust model

Ace treats headers, URL parameters, JSON, directory queries, and remote responses
as untrusted. Mutations require same origin and validated requests. Deployment
credentials stay in GitHub Actions. The Worker receives a dedicated encrypted
`CLOUDFLARE_QUEUES_API_TOKEN`, which needs Queues Edit for the non-consuming
`messages/peek` endpoint. This permission also permits Queue mutations, so Ace
exposes only its explicit read/peek allowlist and discards purge references.
No token is compiled into the browser bundle or plain Worker variables.

Regional operator credentials are separate from Cloudflare credentials and
remain scoped to their regional API. The Access page uses its existing Global
D1 download-grant authority.

## Operations

`deploy-ace.yml` validates the repository, ensures declared Queues, copies the
migration Access policy, injects Ace's audience, verifies the runtime token can
list and peek Queues, deploys the Worker/assets, installs runtime secrets, and
checks the unauthenticated Access redirect. The preferred GitHub secret is
`ACE_QUEUES_API_TOKEN`; `ACE_FLAGSHIP_API_TOKEN` remains an accepted legacy
secret name during transition. The Worker also accepts its previous runtime
secret name until deployment installs the Queue-named secret. Flagship permission is no longer required and
no flag service is provisioned or contacted.

Feature flags and Models are retired from Ace and the engineering MCP. Change
`packages/contracts/src/runtime-config.ts` or optional API variables, then deploy
the API. Existing clients refresh through their HTTP reads or subscriptions.
No flag-change queues or propagation window are involved.

## Changelog

### 2026-11-09 — Retire remote feature and model administration

**What changed:** Ace retains Access, Queues and Workspaces. Flag editors,
Flagship API calls, the flag-administration RPC, provisioning, and fan-out queues
are removed. The runtime Cloudflare credential now serves Queue inspection only.

**Why:** Product features and models are now deployment configuration backed by
central constants and optional variables, so an editor for remote flags would
change settings the product no longer reads.

**Considered and rejected:** Keeping inactive editors would suggest that a
successful remote save changes production behavior.

**What future changes must respect:** Keep Queue inspection's dedicated runtime
credential separate from the deploy token and retain regional operator authority.

## Changelog

### 2026-10-16 — Ace stops managing `digests-enabled`

**What changed:** `digests-enabled` left `MANAGED_FLAGS`, and the deploy
retires it instead of ensuring it. Every managed product flag now defaults the
way its catalog row says, with no digest exception.

**Why:** It was the kill switch for the agent-run digest the 2026-10-15
rewrite replaced, and its live default had drifted to `off`, hiding the Daily
digest settings and stopping delivery for everyone. See
`digests.md` (retired) for the full entry.

**Consequences:** A flag removed from the catalog must also move to a
`retireFlag` call in the same change, or the key stays in Flagship where a
stale value can still be served.

### 2026-10-02 — Edit reasoning with the model route

The Models editor reads and saves optional reasoning effort alongside model
and fallbacks. Model comparisons needed independent effort changes without a
deploy or a separate flag whose rollout could disagree with the model. The
shared route schema also owns MCP validation; Model default removes the field
and preserves existing behavior.

### 2026-10-02 — Deploy stops re-creating retired model flags

**What changed:** The deploy no longer ensures `agent-model-automation-compiler`
or `agent-model-automation-result-disposition`, and it now retires
`agent-model-activity-structured`, `agent-model-addressing-classifier` and
`agent-model-hypersight`.

**Why:** A merge on 2026-09-30 brought back the two automation `ensureModelFlag`
calls after the step that retires them, so every deploy deleted both flags and
created them again. The other three lost their roles earlier, but nothing
deleted their flags, so they stayed in Flagship as dead keys a rollout could
target.

**Consequences:** A key in the retire list must not also appear in an ensure
call; the second step wins and the flag survives every deploy.

PR #1062.

### 2026-09-12 — Use the existing operator identity for connector maintenance

**What changed:** Regional maintenance routes admit the existing Ace demos operator identity for preview, apply, status, resume and cancel; no Ace UI is added.

**Why:** The product owner selected the existing operator identity for reviewed connector maintenance, while read-only engineering access must remain insufficient for provider writes.

**Considered and rejected:** A new permanent administrative secret or arbitrary provider-request/SQL capability.

**Consequences:** Maintenance freezes a reviewed regional selection and records operator attribution. Deployment and a real fleet operation require their own authorization; follow [lifecycle operations](connector-installation-lifecycle.md#operations).

PR #737. Design: [connector installation lifecycle](PRDs/2026-09-12_connector-installation-lifecycle/prd.md).

### 2026-09-10 — New demo casts colleagues from a dropdown

**What changed:** The cast fields are dropdowns of the company's own people —
everyone with a `@rallywith.ai` account who has signed in — and the page sends
user ids rather than names. They open uncast rather than pre-filled, Start is
refused while a part is uncast, one person is in two parts, or two of them
share a display name, and the page says so when there are fewer colleagues than
the pack has parts, instead of a form that cannot be submitted.

**Why:** The team asked for the real addresses: the invented cast was not being
used. A default was dropped with it — yesterday's form opened on the pack's
suggested names because a name is a thing you type over, but a pre-selected
colleague is a real person seated in a demo workspace because nobody looked at
the field.

**Consequences:** The presenter's list and the cast's are now different lists
from the same response, and the page names the domain when it says the second
one is too short — so it reads the domain from the template rather than
carrying a copy of it. A template that reads fine but has nobody to cast is its
own state rather than the "could not be read" one, because Refresh is not the
remedy for it. What the page refuses, the regional API refuses again: the
dropdown is a convenience, not the boundary
(`demo-workspaces.md`).

Shipped in #664.

### 2026-09-09 — Bound and recover early-access operations

**What changed:** The Access page now searches and pages requests and grant history, labels generated links with recipients, and supports revocation and explicit acknowledgement recovery. Recovery uses the existing Global operator credential and reports pending/failed/uncertain mail so an operator can reconcile it without raw SQL. Timed mode is the default; no default duration is invented.

**Why:** Public acquisition needs predictable failure and recoverable operator actions before launch, without imposing account approval or building a campaign system.

**Consequences:** [Private access](private-access.md) owns configuration, undecided numerical limits, and recovery procedures. PR #637.

### 2026-09-09 — Add access intake review and download issuance

**What changed:** Added Access request review and manual single-use/timed grant
issuance through the shared issuer, with operator audit events. The deployment
filter follows shared DB runtime changes so issuer fixes cannot leave Ace stale.

**Why:** Operators need to track early-access interest and supply downloads
without coupling the UI to a future invitation sender.

**Consequences:** Ace writes Global `download_grants` only; identity and membership
remain read-only. Generation sends no mail. [Private access](private-access.md)
owns the grant lifecycle and operator erasure/revocation procedure.

### 2026-09-09 — New demo names its cast

**What changed:** The cast pickers are text fields — **User 1** onwards,
defaulted from the pack — and the page sends names rather than user ids. The
summary shows the cast of a preparation the form is no longer on screen for,
and a gap names the person rather than the pack role. **Retry** is disabled
while an operation is running.

**Why:** Casting from the template's members put Rally's own staff, under
their work addresses, in the demo shown to a customer, and capped the cast at
the template's size; the regional API mints a persona per name now
(`demo-workspaces.md`). Retry on a
running operation was offered for a driver that had died silently, which is
rare, reads as "start again" to whoever is watching a preparation work, and
costs a duplicated attempt when it is pressed; the API still allows it, so
nothing is lost that a deliberate change could not restore.

**Consequences:** The form needs one template member, not one per role. The
page shows names it does not compute — `castNames` comes from the regional
API, which reads the demo's own directory — so a renamed member is renamed on
the page.

### 2026-09-07 — Demos

**What changed:** A Demos page, which lists every preparation with its
phases from the regional API's receipts, starts one with **New demo**, and
retries or abandons a failed one behind a typed operation id. `demos.ts` puts
the `/internal/demos` routes on the relay the Workspaces tab already uses.

**Why:** The demo workspace PRD puts the operator surface in Ace, behind the
Access policy that already admits operators. Relaying rather than reading D1
keeps the operation's rules in one place — the regional service that owns the
Workflow. The states are the PRD's table; nothing is estimated. There is no
**Open in Rally** link because the desktop's deep-link contract has no
home-screen destination; the page says which workspace to switch to instead of
fabricating a link the desktop would reject. From review of the finished page:
the default cast was shifted by one and every default was wrong; the first
paint claimed the template was missing while it was still on its way; a slow
read could overwrite a newer one. So the page reads the template before
judging it, dates the offline banner by the first failure and the last
successful read, shows when a running phase started, keeps a failed wait's
gaps, offers Refresh, deals the default cast out in order, refuses a member in
two roles, labels roles as names, parses every response with the shared
contract, and sequences polls.

**Considered and rejected:** A native confirm dialog for Abandon — the one
irreversible action a tab over uses a typed id, and the regional API requires
one.

**Consequences:** Ace holds no demo state. The typed confirmation is the
pattern for anything irreversible on these pages.

### 2026-09-07 — Workspaces

**Why:** The demo workspace PRD puts the operator surface in Ace, behind the
Access policy that already admits operators, and needs a credential to reach
the regional retirement API. Relaying rather than reading D1 keeps the walk's
rules in one place — the regional service that owns the objects — and keeps
Ace's boundary as it was: no new Cloudflare capability, no product content.
The confirmation is typed rather than clicked because retirement takes any
workspace and nothing else guards it. One operator token per region rather
than one shared value, because a shared token contradicted the per-region rule
in `security.md` and made one leak destructive in both jurisdictions. The
receipt names the workspace and what closed, the form goes, and the row stays
marked, and a failed search is shown as a failure — a retirement that left the
page looking exactly as it had before it, with the button still armed, and a
failed search showing the previous query's rows under the new query, are the
two ways an operator retires the wrong workspace with full ceremony.

**Considered and rejected:** A native confirm dialog — the one irreversible
action on the page uses a typed id, and the regional API requires one.

**Consequences:** Ace holds two operator secrets and each reaches one region.
The typed confirmation is the pattern for anything irreversible on these pages.
The token's role reaches the retirement route only.

### 2026-09-03 — HyperSight has no managed rollout surface

**What changed:** Ace no longer carries the Block Dashboard model role,
feature-flag payload, queue protocol, deployment binding, or editor controls.
Its deploy removes the retired `hypersight-enabled` and
`agent-model-block-dashboard` keys if Flagship still holds them.

**Why:** HyperSight is removed rather than disabled, so leaving an operator
surface would advertise settings with no runtime consumer.

**Consequences:** Ace manages only live Rally capabilities. Flag retirement is
idempotent, so later deploys accept the keys already being absent. Historical
changelog entries still describe the feature while it existed.

Shipped in #541.

### 2026-09-02 — Sol appears only for completely Azure-routed roles

**What changed:** The Models editor suggests `openai/gpt-5.6-sol` above Terra
and Luna for `inline_child` and `block_dashboard`. It omits and rejects Sol for
every role with any direct OpenRouter path.

**Why:** Operators need Sol available for managed Azure-routed roles, while the
cost constraint forbids making it configurable on a path that can execute the
same canonical ID through OpenRouter.

**Considered and rejected:** Treating all eleven roles as equivalent because
they share one Flagship schema. Several roles construct direct structured
OpenRouter requests, and the work-stream role mixes a Bind main turn with one
of those attachment-summary passes.

**Consequences:** The suggestions are role-aware and Ace fails an unsafe save
before provider or Flagship I/O. Sol remains canonical in Flagship, is still
validated against the public model catalog for the two admitted roles, and
relies on Bind for runtime provider enforcement.

### 2026-09-01 — multiple-workspaces-enabled joins the catalog it was assumed to be in

**What changed:** `multiple-workspaces-enabled` was added to `MANAGED_FLAGS`,
to `ProductFeatureFlagKeySchema`, and to `deploy.mjs`, making it Ace's sixth
managed product flag and its fifth presentation control. Two new
`protocol.test.ts` cases fail when a product Boolean the API resolves is absent
from this catalog, and when a served key opts out of Ace by not being named
`-enabled` without being listed as a deliberate exception.

**Why:** The flag shipped in #464 resolved by the API and consumed by Electron,
but registered nowhere here. Nothing created it in Flagship, so it did not
exist in the app at all: the feature was off for every account with no operator
able to turn it on, and each desktop poll logged an unresolved flag. Every
existing check starts from this catalog and walks outward to `deploy.mjs`, so a
flag that never reached the catalog passed all of them.

**Considered and rejected:** Having Ace list whatever Flagship returns instead
of a hard-coded catalog. That would have surfaced this flag only once something
else created it, and it would surrender the labels, descriptions, and defaults
that make an operator page readable — `developer-settings` and
`control-tower-refresh-seconds` are deliberately not Ace's to manage, and a
live listing cannot express that. The catalog stays authoritative; the new test
makes its incompleteness fail on the pull request.

**Consequences:** Adding a product Boolean is now four edits, not one, and the
suite says so before merge. The `-enabled` suffix is load-bearing: it is what
separates a flag Ace must manage from one it must not, so a flag kept outside
Ace must keep a key that does not end in `-enabled`. Deploying this creates the
flag with no rules at its `off` default, which changes nothing for anyone until
a targeting rule is added.

### 2026-08-26 — Models makes every agent route editable without flattening rollouts

**What changed:** Ace gained a Models navigation section for all eleven roles
declared by `agent-model-flags.ts`. Each role carries a code-derived explanation,
its checked-in primary and fallback defaults, an explicit importance-and-usage
rank, a suggested model list, validated free-text OpenRouter ids, and an ordered
fallback editor. Every edit is checked
against OpenRouter's live endpoints API, and the Worker repeats that check
before any Flagship mutation. Saving replaces only the route
plan stored in the live flag's current default variation; the Worker reads the
complete flag immediately before PUT so its status, targeting rules, rollout
percentages, and staged variations survive. Deployment now creates any missing
model flags from the same hard-coded defaults before publishing Ace.

**Why:** Model routing was operationally configurable but required an operator
to translate eleven opaque Flagship keys back into their call sites and edit
JSON by hand. That made the easy change — move one concrete loop to a new
primary or fallback — depend on code spelunking every time and made an invalid
or reordered fallback array easy to write.

**Considered and rejected:** Replacing each model flag with one Ace-owned
variation. It would make the editor simpler but silently erase regional and
workspace rollouts that Flagship already supports. A second Ace-owned database
was also rejected: the API Worker evaluates Flagship on every admission, so a
parallel store would add synchronization and a second authority without making
the run path simpler.

**Consequences:** Ace intentionally edits only the current default variation;
advanced cohort rollouts still use Wrangler or Flagship. A custom model id is
allowed only after OpenRouter returns the exact id with a current serving
endpoint, unlike the desktop's closed reviewed work-stream pin list. A provider
validation outage therefore blocks model saves rather than risking an unusable
route. The role and route-value contracts are shared with the API; Ace's
code-derived explanations, defaults, and ranks remain hard-coded, with a parity
test that fails when the shared role catalog gains an entry. Model saves append
the ordinary Flagship changelog entry but send no product-flag Queue
notification: there is no client cache to wake, and a run resolves the route
when admitted. Cloudflare offers no conditional flag update, so concurrent
edits remain last-writer-wins; disabling unchanged saves reduces accidental
rewrites but does not manufacture a concurrency guarantee the provider lacks.
OpenRouter lookups abort after five seconds so a provider that accepts a
connection and stalls cannot hold the operator request indefinitely.

### 2026-08-25 — Queues exposes live dead-letter backlogs and non-consuming message inspection

**What changed:** Ace gained a Queues navigation section backed only by
Cloudflare's REST API. It derives the active DLQ set from Queue consumer
configuration, reads each realtime backlog count, byte size, and oldest
timestamp, and shows one provider-defined peek batch with attempts, time, body,
and metadata. The existing dedicated Ace token and Worker binding remain in
place and now require Flagship Write plus Queues Edit; their legacy
Flagship-specific names are retained to avoid a credential migration.
Deployment now proves the token can perform a non-consuming Queue peek before
installing it.

**Why:** Dead letters were already the intentionally simple production signal
for several Queue-driven subsystems, but investigating that signal meant leaving
the internal operator application and using Cloudflare directly. Operators need
the size and the actual failed envelope together to distinguish one poison
message from a growing delivery failure.

**Considered and rejected:** HTTP pull followed by no acknowledgement. It can
return bodies, but it leases every inspected message and temporarily changes
what another consumer can see. Cloudflare's newer `messages/peek` endpoint is a
closer contract because messages remain available for later peek or pull.
Classifying DLQs by the repository's naming convention was also rejected: a
name is compatibility text, while the consumer's live `dead_letter_queue`
relationship is the provider's authority. Finally, giving Ace the deployment
token was rejected because Queue inspection does not justify Worker, Access,
D1, route, or other account-administration permissions.

### 2026-08-25 — Targeting rules gain drag-to-reorder

**What changed:** Each rule card in the flag editor now has a drag handle;
dropping one rule onto another moves it to that position. The dragged rule's
own index travels on the native `dataTransfer` payload rather than only in
React state, so `onDrop` reads it back synchronously instead of depending on
a commit landing first. The same handle is a real `<button>` that also
answers ArrowUp/ArrowDown, moving the rule one position and announcing the
result (`aria-live="polite"`) for a keyboard or screen-reader operator who
cannot perform the drag gesture at all. Every rule now carries a client-only
`_clientId`, assigned once when it is loaded or created and stripped back out
before save, so React tracks a moved rule's own card — and the local state
inside it — rather than whichever rule now sits at its old position.
`priority` is still recomputed from array position on save, same as before —
reordering the rules array was always how a save would express a new order,
this just gives the editor two ways to produce that reorder without deleting
anything. `reorderRules` is the pure function behind both paths, unit-tested
directly rather than through a simulated pointer gesture.

**Why:** "Rules run from top to bottom, the first match wins" is Flagship's
real behavior, stated directly in the editor's own copy — but the only way to
change that order was removing a rule and re-adding it at the bottom, since
`+ Add rule` always appends. That was not a hypothetical gap: an operator
adding a personal override on top of an existing workspace-wide rule got the
opposite of what they configured, because the broader rule sat first and
Flagship never reached the narrower one. Nothing in the editor said so.

**Considered and rejected:** Separate move-up/move-down buttons instead of
arrow keys on the drag handle itself. Review caught that the first version of
this shipped drag as the *only* way to reorder — a `<span role="button">`
grip with no `tabIndex` and no keyboard handler, despite the doc above
claiming it was the only way to reorder, which made it doubly true for anyone
who could not drag. Dedicated buttons were the more conventional fix, but
putting the same ArrowUp/ArrowDown affordance on the existing handle needed no
second control, and `aria-keyshortcuts` on that one element documents both
interactions in the same place.

**Consequences:** `Panel` now spreads arbitrary HTML attributes instead of
accepting only `className`, so a rule card can carry `onDragOver`/`onDrop`
without a one-off prop grown just for this. Rule cards keyed by array
position — the first version of this — reordered the data on drop but left a
card's own local lookup state (the friendly label a person or workspace
search resolves to) behind at the old position; reviewed and confirmed in a
real browser before `_clientId` fixed it. A separate, position-indexed ref
array still exists purely to move keyboard focus after a move — unaffected by
the key fix, since a ref read immediately after the render that populated it
is never stale the way state surviving across renders at the same key can be.
A keyboard move reorders the data but leaves focus sitting on the position it
started at, so the editor explicitly refocuses the handle at the rule's new
position after every keyboard move, or a second arrow-key press would
silently move whichever rule had landed there instead. Putting the dragged
index on `dataTransfer` also made the drop handler synchronously correct on
Firefox, which never begins a drag whose `dragstart` handler left
`dataTransfer` untouched — and let `onDragOver`/`onDrop` gate on that same
payload's presence, so a card no longer swallows a drag that was never a rule
drag (dragged text, a link, a file). No Flagship-side change; the save
payload this produces was always a valid one, `_clientId` included and
stripped before it is sent.

### 2026-08-25 — Ace manages a fifth flag, its first that is not presentation-only

**What changed:** Ace's catalog gained `digests-enabled`, a kill switch for
scheduled digest delivery. Unlike every flag before it, Electron never reads
it — `apps/api/src/services/digest-flags.ts` reads it directly at the moment a
digest is about to fire — and `apps/ace/scripts/deploy.mjs` provisions it with
`default_variation: 'on'` rather than `ensureFlag`'s ordinary `'off'`, because
a digest already sends by default for every existing person.

**Why:** An operator needed a real stop for digest delivery, not a hidden
settings screen: digests run from a cron reconciler nobody visits a UI to
trigger, so a presentation-only flag in the existing pattern would have hidden
nothing that controls delivery. Reusing Ace's existing editor, write path, and
Queue fan-out — rather than building a second flag-editing surface — keeps one
place an operator looks for every Boolean flag they might need to change by
hand.

**Considered and rejected:** A bespoke write path that skips the Queue
notification for flags outside `ClientFeatureFlagsSchema`, to avoid triggering
a client re-evaluation nothing needs. Rejected because the fan-out is harmless
idempotent work — it always re-sends the complete client contract regardless
of which key changed, so a `digests-enabled` save just repeats a
re-evaluation that was already safe to repeat — and a conditional fan-out
would be a second code path for every future flag to reason about, bought for
a cost that shows up nowhere a person would notice it.

**Consequences:** `ensureFlag` now takes a default-variation argument, and each
`MANAGED_FLAGS` entry in `protocol.ts` carries its own `defaultVariation` —
`'off'` for every presentation flag, `'on'` only for `digests-enabled` — so the
client editor's skeleton state agrees with what `deploy.mjs` provisions before
either has read a real value from Flagship. The two still cannot read one
shared object: `deploy.mjs` runs under plain Node rather than through Vite, so
it cannot import `protocol.ts` and resolve the extensionless relative imports
elsewhere in the TypeScript graph. `deployment-contract.test.ts` closes that
gap in a test instead, checking every managed flag's provisioning call against
its catalog entry, so a silent regression back to `ensureFlag`'s ordinary
default fails CI rather than stopping every digest in production on the next
deploy.

### 2026-08-25 — Ace merge deployment follows its runtime boundary only

**What changed:** The merge-to-main path filter now follows the shared
TypeScript configuration and the Queue provisioner's transitive entry-point
helper. It excludes Ace tests and contract tests, and drops the Queue
provisioner's test file from the include list, while an exact
deployment-contract assertion pins the complete list.

**Why:** The old list could leave production on a bundle built under an older
compiler configuration or defer a deployment-helper change until an unrelated
merge. It also caused the production Ace deployment for the analytics lakehouse
merge even though the only matching file was a Queue provisioner test.

**Considered and rejected:** Treating every repository test or every API
Wrangler configuration as an Ace deployment input. CI owns test validation, and
the API and migration-tracker workflows already provision the Queue declarations
their own runtime changes introduce; redeploying an unchanged Ace Worker adds no
repair. Expanding this Ace correction into an audit of the API,
migration-tracker, and site path filters was also rejected as separate module
scope; this entry makes no claim that those workflows have the same complete
boundary.

**Consequences:** A runtime-relevant merge cannot miss Ace through these known
shared inputs, while a test-only merge no longer performs a credentialed
production deployment. Adding another external build or deployment module also
requires adding it to the pinned path contract.

### 2026-08-24 — Review hardens live delivery and records Ace's regional exception

**What changed:** Initial desktop reads now fetch immediately despite their
fail-closed render seed; every Electron surface defaults managed Booleans off;
meeting controls consume live socket-backed values; queue batches deduplicate
keys and prove cursor pagination; deployment follows changes to the shared
Access verifier. Misleading partial local-Ace commands were removed, and the
regional section now describes the directory fields Ace transiently reads.

**Considered and rejected:** Routing Ace directory search through a new regional
RPC. The product requirement deliberately makes this internal Access-gated
application the cross-region lookup plane; adding a bridge would change that
boundary rather than fix the inaccurate claim.

**Consequences:** A render seed is never treated as a completed server read,
managed Electron UI remains off until an exact server `true`, one Queue batch
enumerates each region once per distinct key, and regional documentation must
continue to name Ace's narrow operator-search exception.

### 2026-08-24 — Ace becomes the managed product-flag write path and manages Suggested Work and workspace template rollouts

**What changed:** Ace was introduced as an Access-protected Hono Worker with a
shared component library, D1-backed targeting editor, automated Flagship
provisioning, and a shared-to-regional Queue fan-out that updates connected
desktop clients through WorkspaceDO. Its fixed product-flag catalog includes
Suggested Work Enabled and Automation Workspace Templates Enabled alongside the
first two product flags, and its automatic deploy provisioner creates both as
Boolean flags with an off variation, an on variation, and an off default.

**Why:** Product managers need to stage user-facing features by human concepts
such as a person, workspace, role, or domain without copying opaque IDs or
deploying application code. Connected clients also need a change promptly, but
the effective answer differs per user and Flagship exposes no documented
outbound change notification. Suggested Work and workspace templates are
existing application surfaces that need staging through the same ergonomic
targeting editor and key-only notification path as the first two product flags,
without dashboard-only configuration that would bypass connected-client
notification.

**Considered and rejected:** Polling every desktop makes propagation depend on
every client timer and repeats work forever. Sending one value through the
fan-out is incorrect for targeted rules. Using the Flagship dashboard directly
cannot trigger Avalon's Queue path. Giving Ace the deployment token would make a
runtime compromise an account-administration compromise. For the two additional
flags, a second editor or a separate Flagship application would duplicate
targeting vocabulary and split one global rollout control plane without
introducing a distinct trust or residency boundary.

**Consequences:** Managed product flags must be edited through Ace, Queue
payloads remain key-only, reconnect remains the repair path, and future Ace
pages reuse its Access boundary and component library. The Flagship-only runtime
credential is a standing deployment prerequisite. Ace's managed set is four
flags. Adding another product Boolean requires an Enabled-named key, fail-closed
Electron visibility, automatic provisioning, and inclusion in the shared key
schema. These controls must not change API availability.
