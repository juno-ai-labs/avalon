# Research: what a public ChatGPT or Claude share page actually serves

> Investigation behind
> [the importing-public-sessions PRD](prd.md), recorded on 2026-09-12 from the
> development sandbox described in [`sandbox.md`](../../sandbox.md). Everything
> below is either something that was observed, with the observation dated, or
> is marked as not verified. It is provenance, not a proposal; the PRD decides.

## 0. What was and was not verifiable from the sandbox

| Path | Result | Why it matters |
| --- | --- | --- |
| Plain HTTPS `GET` of the two example pages through the sandbox proxy, with a desktop-browser `User-Agent` | ChatGPT: `200`, 669 KB of HTML. Claude Code session: `403` with a Cloudflare managed challenge (`cf-mitigated: challenge`). | Decides which pages a request-only fetcher can read. |
| Headless Chromium (Playwright, the sandbox's own `/opt/pw-browsers/chromium`) against either page | `net::ERR_CONNECTION_RESET` for both hosts, including `chatgpt.com`, which `curl` reads. The proxy's status endpoint logged `ws_closed_mid_exchange` for each attempt. | A sandbox limitation, not a fact about the sites. No browser-based fetch could be tested here. |
| Firecrawl `/scrape` with `proxy: "stealth"` | Not run: `.env.local` carries an empty `FIRECRAWL_API_KEY`. | The spike the PRD's rollout gates Claude import on is exactly this call. |
| Cloudflare Browser Run `quickAction` | Not run: needs the Worker's `BROWSER` binding, which only exists in a deployed or `wrangler dev --remote` Worker. | Same spike, second candidate. |

So: ChatGPT's page shape is verified in full; Claude's is verified only as far
as "a non-browser client is challenged", and everything said about its payload
is recalled rather than observed.

## 1. ChatGPT share pages (`https://chatgpt.com/share/<uuid>`)

### The transcript is in the HTML, as data, not as markup

The page is a React Router application. Its server-rendered HTML carries no
transcript DOM at all — there is no `data-message-author-role`, no message
container, nothing a markdown conversion would find until the client hydrates —
but it carries the complete conversation as a **React Router data stream**:
two `<script>` calls of the form

```js
window.__reactRouterContext.streamController.enqueue("[{\"_1\":2, …}]\n");
```

whose payload is the `turbo-stream` encoding (v2, the flattened array of values
with `_N` index references) of the route's loader data. Decoding it with the
`turbo-stream` package (`decode`, v2.4.1 at the time of writing) yields:

```
loaderData["routes/share.$shareId.($action)"]
  .sharedConversationId          the share id
  .serverResponse.data           the conversation, see below
  .meta.pageTitle                "Create Work Graph Infographic"
```

and `serverResponse.data` is the same shape the ChatGPT backend returns for a
shared conversation:

| Field | Observed value or shape | Use |
| --- | --- | --- |
| `title` | `"Create Work Graph Infographic"` | Artifact title, block header |
| `create_time`, `update_time` | Unix seconds, fractional | Original instants |
| `conversation_id` | the share id | Source identity |
| `is_public` | `true` | Refuse anything else |
| `linear_conversation[]` | 55 nodes for the example; each `{ id, message? }` in reading order | The turns |
| `mapping` | the same nodes as a parent/child tree; `current_node` names the leaf | Not needed: `linear_conversation` is already the displayed branch |
| `continue_conversation_url` | `…/share/<id>/continue` | Not used |

Each `message`:

| Field | Values seen | Import rule |
| --- | --- | --- |
| `author.role` | `user`, `assistant`, `tool`, `system` | `user` → the owner's turn; `assistant` → the assistant's turn; `tool` → folded into the assistant's turn only when it carries something the page shows (an image); `system` → dropped |
| `author.name` | absent for `user` and `assistant`; a tool id such as `t2uay3k.sj1i4kz` for `tool` | Not a person's name. **This share carried no owner name anywhere in the payload** — a ChatGPT share is anonymous unless the sharer opted in. |
| `content.content_type` | `text`, `multimodal_text`, `thoughts`, `reasoning_recap`, `code`, `model_editable_context` | Only `text` and `multimodal_text` are content a reader sees; the rest is reasoning and tool plumbing |
| `content.parts[]` | strings; or `{ content_type: "image_asset_pointer", asset_pointer: "sediment://file_…?shared_conversation_id=…", mime_type, size_bytes, width, height }` | Text parts join with a blank line; image parts become attachments |
| `metadata.is_visually_hidden_from_conversation` | `true` on the tool's "saved at /mnt/data…" note and on the redacted custom-instructions node | Dropped: what the page hides is not imported |
| `metadata.turn_exchange_id` | one id shared by a user message and everything produced in reply | Groups an exchange; the assistant's several segments fold into one turn |
| `metadata.model_slug`, `resolved_model_slug` | `gpt-5-4-thinking`, `gpt-5-4-auto-thinking` | Kept in the turn's structured content; shown in the block header |
| `metadata.attachments` | absent in the example; carries `{ id, name, mimeType, size }` for user uploads | Name and size only; the bytes are not on the page |
| `metadata.is_redacted` | `true` on the `"Original custom instructions no longer available"` node | Dropped |
| `create_time` | Unix seconds | Original instant per turn |

Two observations that shape the PRD:

- **An assistant turn can have no text at all.** In the example every
  `assistant`/`text` message has `parts: [""]`; the visible reply is the image
  the `tool` node carries. An importer that drops tool nodes wholesale imports
  seven empty assistant turns. The rule is therefore "what the page shows", not
  "what the role says".
- **The images are pointers, not URLs.** `sediment://file_…` is resolved by the
  hydrated client through an authenticated-looking backend call. The JSON API
  behind the share (`/backend-api/share/<id>`) returned `403` to the same client
  that read the page, so the pointers cannot be resolved by a request-only
  fetcher; they can be read off the rendered DOM's `<img src>` by a browser-based
  one. This is why attachments are best-effort in the PRD.

### What a markdown scrape would have produced

Firecrawl's existing client requests `formats: ["markdown"]` with
`onlyMainContent: true`
([`apps/api/src/lib/firecrawl.ts`](../../../apps/api/src/lib/firecrawl.ts)). On
this page that is the hydrated transcript flattened to prose: role boundaries
survive only as visual cues, hidden nodes are already gone, and there is no
model name, no instants, and no exchange grouping. Good enough to read, not good
enough to attribute — which is why the PRD asks for the raw page and decodes the
data instead.

## 2. Claude pages

Three URL shapes exist, and they behave differently to a non-browser client:

| URL | Observed on 2026-09-12 | Notes |
| --- | --- | --- |
| `https://claude.ai/share/<uuid>` (a shared Claude.ai chat) | `200`, a 114 KB application shell with no transcript in it; the bundle references `/api/chat_snapshots/…` | The data is loaded by the client from that API |
| `https://claude.ai/api/chat_snapshots/<uuid>` | `403`, `cf-mitigated: challenge` | The API is challenged even when the shell is not |
| `https://claude.ai/code/session_<id>` (a Claude Code session the owner made public) | `403`, `cf-mitigated: challenge`; `robots.txt` is served normally | The page itself is challenged |

The challenge is Cloudflare's managed challenge — a JavaScript check a real
browser passes without user interaction, which a request-only client cannot
pass at all. What that means for each fetcher:

- **Firecrawl** advertises `proxy: "stealth"` for exactly this class of page,
  and the shipped client already sends `proxy: "auto"`, which escalates to
  stealth on failure. Whether it passes claude.ai's configuration is **not
  verified**.
- **Browser Run** executes a real browser, but from Cloudflare's own address
  space; nothing exempts it from a customer's managed challenge. **Not
  verified** either way.
- A request-only fetch (the Worker's own `fetch`, Firecrawl with
  `proxy: "basic"`) is verified to fail.

The Claude Code session page is also the one the request names as carrying the
owner ("it says this is Adam's session"). That label was not observed here; the
PRD treats "the page names its owner" as a per-provider fact the adapter reports,
present for Claude Code sessions and absent for anonymous ChatGPT shares.

What the classic share API is expected to return, from memory and **not
verified**: `{ name, chat_messages: [{ sender: "human" | "assistant", text,
files, attachments, created_at, … }] }` — a flat list with the two speakers
named, which is a simpler mapping than ChatGPT's. The Claude Code session
transcript's shape is unknown until the spike reads one.

## 3. The three fetchers the request offered, against what the repository has

| | Firecrawl `/scrape` | Cloudflare Browser Run | Daytona computer use |
| --- | --- | --- | --- |
| In the tree today | Yes: [`apps/api/src/lib/firecrawl.ts`](../../../apps/api/src/lib/firecrawl.ts), the `rally:web` plugin's `search` and `fetch`, a regional `FIRECRAWL_API_KEY` in both regions | Yes: the `BROWSER` binding in both regional Wrangler files, used by `conversation-link-search.ts` for link capture | Yes, as the Terminal sandbox — one per work stream, no browser in the snapshot, both regions target the `us` fleet |
| Gets past a managed challenge | Designed to (stealth proxies); unverified for claude.ai | Unverified; likely not exempt | Would need a browser installed in the snapshot and `full_internet` egress; unverified |
| Returns raw HTML | `formats: ["rawHtml"]` — one option away; the client today asks for markdown only | `quickAction("content")` returns the rendered DOM | Whatever a script writes to disk |
| Rendered-DOM image URLs | With `formats: ["html"]`, or `actions` | Yes, it is the rendered DOM | Yes |
| Where it runs | Firecrawl's infrastructure, from either region — the same subprocessor the web plugin already uses; only the URL leaves Rally | Cloudflare, in each regional Worker; no third party | Daytona `us` — a subprocessor exception [`regionalization.md`](../../regionalization.md) already records for Terminal |
| Failure surface the repo already handles | `FirecrawlError` with `kind` and `retryable`, `Retry-After`, four attempts with backoff | Provider `code` on a `422` (a `5006` connection-closed case is recorded in [`text-search.md`](../../text-search.md)) | Sandbox lifecycle |
| Weight for one fetch | One HTTPS call | One HTTPS call | Sandbox acquisition, a browser, a script, and cleanup |

The PRD's decision follows from the last row and the first: one call, already
wired, already regional, with the one property the Claude pages need still to be
proved. Browser Run is the fallback because it is also already wired and keeps
the bytes on Cloudflare. Daytona is rejected for a fetch.

## 4. Client-side pieces already present

- `lucide-react@1.34.0` (installed in `apps/desktop`) exports **`Import`** — an
  open-topped box with an arrow pointing down into it, unused anywhere in the
  renderer today. `Download` (a tray, reads as "save to disk"), `ArchiveRestore`
  (arrow pointing *out*), and `FolderInput` (arrow pointing sideways) were
  considered and are worse matches for "bring this in".
- `@thesvg/react` ships the brand marks with a `mono` variant that
  [`using-company-brand-icons.md`](../../using-company-brand-icons.md) requires
  for the transcript: `@thesvg/react/openai-chatgpt` (`OpenaiChatgpt`) and
  `@thesvg/react/claude` (`Claude`). Both are subpath imports, per that
  document's one enforced rule.
- The transcript already draws external authors: `actor: "external"` with an
  `ExternalActorSchema` `{ provider, providerAccountId, providerUserId,
  displayName, avatarUrl }`, used by Slack and by inbound email from a
  non-member. The byline suffix for it is the literal `· Slack`
  (`workstream-blocks.tsx`), which is the one line the PRD generalizes.
- The transcript already folds a stretch of rows behind a chevron:
  `WorkAccordionBlock` ("Worked for 41m 17s"), derived on the client from
  contiguous rows, with per-reader disclosure state that survives the
  virtualizer. The imported-conversation block is the same shape with a
  different header.
