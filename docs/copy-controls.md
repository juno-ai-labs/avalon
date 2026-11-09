# Copy controls

Every place the desktop renderer offers to put a value on the clipboard for a
person — a webhook endpoint, a signing secret, an invite link, a Canvas's
email address or id, a run's request id, a site's public link, a table as CSV,
a note's summary or transcript, a code block — renders the same control: an
icon beside the value, named by its tooltip, whose glyph says what the copy
did. One hook under it holds the outcome and the timer that clears it.

The promise is that a copy is never silent and never a sentence. The clipboard
refuses often enough (an unfocused window, a denied permission) that a control
has to be able to say it failed and offer the same click again; and a value
shown to be copied wants its control beside it, not a labelled button under it
saying "Copy endpoint" where the field already says what it is.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/lib/use-copy.ts` | `useCopy` — the one copy-to-clipboard behaviour: the write, the `idle` / `copied` / `failed` state it settles into, and the reset timer. `COPY_FEEDBACK_MS` is how long an outcome shows. |
| `apps/desktop/src/renderer/components/copy-button.tsx` | `CopyButton` — the icon control every copy affordance renders, and `CopyField` — a caption, the value in a read-only field, and the control beside it. |
| `packages/ui/src/styles/app.css` | `.copy-button-copied` and `.copy-button-failed` colour the outcome's glyph; `.copy-field` lays the field and its control on one row; `.copy-detail` is the older "value beside its control" row the inspector rail and the run-failure notice share. |

## How it works

`useCopy` takes the value — a string, or a function for a value fetched or
built on demand, such as a CSV the server renders — and the clipboard to write
it to, which is the desktop bridge unless a surface carries its own (the site
resource detail hands in the surface it was given, because it renders where
nothing can composite a view). `copy()` writes and settles into `copied` or
`failed`; it never rejects. On success it runs `onCopied`, which is where a
caller reports its `content_copied` telemetry. Either outcome shows for
`COPY_FEEDBACK_MS` and then the state returns to `idle`, so the same control
is ready for the same click; a failure's retry is that click. The options are
read at click time through a ref, so `copy` keeps one identity while the value
under it changes.

Each rejected write also carries a fresh `failureOccurrence`, passed to visible
`CopyStatus`. Acknowledging one failed attempt cannot silence another failure
before the feedback timer resets. The status component stays mounted across
failure and retry so a later success updates its existing live region.

`CopyButton` is an `IconButton` over that hook. While idle its name and
tooltip are the caller's label (`Copy endpoint`); while showing an outcome the
name is `Copied` or `Copy failed — click to retry`, the glyph is a check or an
alert, and a colour says which. After a click the tooltip is closed — Radix
closes it on the press — so the glyph is what the person is looking at, and a
`role="status"` live region beside the button announces the outcome for a
screen reader. The region is always mounted and empty while idle, so it exists
before it has something to say.

`CopyField` is the composition for a value shown to be copied rather than read:
a `<label>` over a read-only `<input>`, the control in the same grid row, and
`secret` to mask the value. The inbound-webhook result renders two of them, an
endpoint and a secret.

## Invariants

- **A button that copies a value is a `CopyButton`, or drives `useCopy` under
  a control of its own.** Nothing automated lists the files that may
  call `copyText` on the bridge directly; a guard that fails when another
  appears should be a `no-restricted-imports` entry
  ([`testing.md`](testing.md#what-to-test-and-what-not-to)). What
  may: a menu item, whose row is its label and whose menu closes on the click,
  and `copy-link.ts`, the helper those items share. The
  message-action row's **Copy** is the one labelled pill that stays: it is one
  of a family of labelled pills under a turn, owned by
  [`conversation-surfaces.md`](conversation-surfaces.md). The message-text
  context menu's **Copy** writes formatted HTML through the renderer clipboard
  rather than `copyText`, because the IPC channel cannot carry HTML and caps
  at 4,000 characters. That write sanitizes the clone: nodes marked
  `data-clipboard-exclude` (code-block copy, heading chevrons) are removed;
  citation chips and cards are unwrapped so their labels stay in both flavors.
- **The outcome and its timer live in the hook.** No control keeps a `copied`
  flag or a `setTimeout` of its own; the same test asserts it. That is what
  keeps every control showing an outcome for the same time.
- **A copy is never silent.** The glyph, the name, and the live region change
  together. A control that can fail without saying so is the defect this
  replaced: a one-time secret cannot be read back off the screen, so a failed
  copy there had to be a thing the administrator is shown.
- **The control is an icon, and the label is its tooltip.** A text button
  saying "Copy endpoint" under a field captioned "Endpoint URL" was the shape
  this replaced everywhere it appeared.

## Boundary

The hook owns the clipboard write and what a control shows about it. It does
not own the value's provenance, the telemetry vocabulary — `content_copied`'s
`contentType` is `@rally/contracts`' — or where the control sits. A copied
message is named by its transcript turn id (`copiedMessageId`), not by the
rendered block's id (`<turn>:text:0`). A person's turn id is a UUID, and an
assistant's is its loop's identity and ordinal
(`workstream:<parent>:substream:<0|id>:loop:turn:<n>`); the contract admits
exactly those for `resourceType: "message"` and a UUID for every other
resource. A surface
decides that: beside the value in a `.copy-detail` row, in a `CopyField`, or in
a toolbar. Menu items and the code block's header keep their own elements and
share only the behaviour; the code block does so because markdown renders
wherever a card is drawn, including one drawn for export with no tooltip
provider above it.

## Failure modes and limits

- **The clipboard refuses.** The control shows `failed`, announces it, and the
  next click retries. Nothing is logged: the reason is the platform's and the
  person's next click is the recovery.
- **A masked secret cannot be copied by hand.** Chromium blocks copying from a
  password field, so `CopyField`'s control is a secret's only way off the
  screen; a persistent failure there has no fallback short of connecting again.
- **`COPY_FEEDBACK_MS` is two seconds.** A design constant rather than a
  defensive limit: long enough to be seen, short enough that a second copy from
  the same control reads as a second event.

## Testing

| Command | What it proves |
| --- | --- |
| `pnpm --filter @rally/desktop exec vitest run src/renderer/lib/use-copy.test.tsx` | The hook: writes through the bridge or the clipboard it is handed, settles into `copied` or `failed` without rejecting, resolves an on-demand value, reports only on success, resets after the interval, and leaves no timer behind on unmount. |
| `pnpm --filter @rally/desktop exec vitest run src/renderer/components/copy-button.test.tsx` | The control: an icon named by its label with a tooltip, the outcome in its name, class and live region, the failed state's retry, and `CopyField`'s read-only and masked fields. |

Artifact and attachment title menus use `useCopy` for their copy tile and keep
a `CopyStatus` live region outside the menu so the outcome survives closing it.
Both show success through the shared `Toast` over the preview, without changing
its size. Keep visible `CopyStatus` in a non-scrolling, positioned ancestor of
the preview so it stays below the header after scrolling.
Failed copies use an acknowledged error popup. Other copy controls retain
their screen-reader-only status because their outcome remains on the visible icon.
An attachment gallery keys its copy scope to the selected resource, so changing
files clears the outcome and discards feedback from a write that finishes later.
Attachment action tiles share the artifact menu's wrapping labels, including
the longer failed-copy retry label.

The surfaces' own tests — the inbound-webhook dialog, the invite link, the
inspector rail, the run-failure notice, the site detail, the code block —
assert on the control by its accessible name.

## Changelog

### 2026-11-08 — A copied assistant reply is reported by its turn id

**What changed:** A copy reports the message's transcript turn id rather
than its rendered block's id, and `content_copied`'s `resourceId` admits an
assistant turn id when `resourceType` is `message`, matched exactly to the
loop's turn form.

**Why:** Every Copy of a reply threw `Invalid telemetry intent` in the main
process and dropped the event: the renderer sent the block id
(`<turn>:text:0`), which is no UUID, and an assistant's turn id is not one
either once the transcript keys it by the loop. Keeping the message's
identity was the point of the event, so the sender names the turn and the
contract widened, rather than the sender dropping the id; the transcript's own
`TranscriptTurnIdSchema` (any non-empty string) was rejected because a
telemetry value must not be able to carry free text.

**What a future change must respect:** a new turn-id form has to be added to
the contract's pattern, or its copies are refused again at the IPC gate.

Shipped in juno-ai-labs/avalon#1490.

### 2026-10-21 — Copy confirmation floats over its preview

**What changed:** Visible `CopyStatus` uses the generic shared `Toast` pill,
with retained entrance/exit motion and the existing two-second `useCopy` lifetime.
Failures use the acknowledged popup instead of the retired status banner.
Rejected writes carry distinct occurrences so quick retries reopen the notice;
the inspector keeps the same toast live region mounted through failure and retry.

**Why:** The plain “Copied” row looked like page content and resized the preview.
The product requested temporary animated confirmation in the existing app style.

**Considered and rejected:** A second timer in the toast would compete with
`useCopy`; a DOM-only overlay would disappear beneath Electron's native site view.

**Consequences:** Keep the toast outside layout flow and its live region mounted.
Regular and detached panels anchor feedback outside their scrolling content.
Native sites show their existing still while an overlapping toast is present,
including its exit. Gallery selection still owns and clears its copy feedback.

PR: [#1393](https://github.com/juno-ai-labs/avalon/pull/1393).

### 2026-09-13 — One icon control for every copy affordance

**What changed:** `useCopy` and `CopyButton` were added, with `CopyField` for a
value shown in a read-only field. The Fireflies setup, the inbound-webhook
result, the invite link, the run-failure notice and the site detail's CSV
export replaced their labelled `Copy …` buttons with the icon control; the
inspector rail's email and id controls, the site detail's public-link control
and the meeting-notes header controls replaced their hand-rolled state with
it; the code block's header control drives the hook. The run-failure notice
now shows the request id beside its control. The bridge's direct callers are
only the menu items.

**Why:** The product asked for copy icons instead of labelled buttons in the
Fireflies setup and the same look everywhere a value is offered for copying.
Each site had its own version of the behaviour: a sentence under the field, a
label that claimed success before the write had landed (the webhook dialog),
no feedback at all (the meeting-notes controls, the work-stream id), and a
reset after one and a half seconds here and two there.

**Considered and rejected:** Keeping the labelled button and only changing its
icon, which leaves the sentence under the field and the per-site state. Also
rejected: a text sentence for the failed case in the two secret dialogs, which
the old Fireflies dialog had; the control now carries the failure itself, and
a sentence advising the person to copy the secret by hand was advice a
password field cannot honour.

**Consequences:** A new surface that copies a value renders `CopyButton` and
adds nothing else; a new menu item that copies is added to the guard's list as
a decision. The message-action row's **Copy** pill is deliberately left as
one of its family.
