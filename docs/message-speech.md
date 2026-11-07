# Speaking a message

Every finished Rally response has a **Speak** action that reads the complete
message with an AI-generated voice. Playback starts from a regional,
authenticated PCM stream and the action becomes **Stop speaking** until the
stream finishes or the person stops it.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` | The icon-and-text action under a finished response; it always passes the stored markdown, not the visible collapsed DOM. |
| `apps/desktop/src/renderer/components/message-text-menu.tsx` | The feed message's right-click Speak / Stop speaking, the same toggle and stored markdown as the action row. Hidden while the turn is still streaming. A human body names the item *Speak*. |
| `apps/desktop/src/renderer/components/speech-playback.tsx` | The one-active-message mutex, immediate AudioContext activation, cancellation, and failure logging. A second Speak from any surface stops the clip that is already playing. |
| `apps/desktop/src/renderer/lib/pcm-speech-player.ts` | Incremental 24 kHz signed little-endian PCM decoding and gapless Web Audio scheduling. |
| `apps/desktop/src/renderer/lib/api.ts` | Authenticated `POST /speech` fetch and response-format validation without body buffering. |
| `apps/api/src/routes/speech.ts` | The protected regional streaming response and content-free operational events. |
| `apps/api/src/services/message-speech-service.ts` | Markdown-to-speech text reduction, Azure-sized chunking, one-chunk prefetch, and provider-stream composition. |
| `apps/api/src/services/multimodal-generation/azure-audio-client.ts` | The shared `gpt-4o-mini-tts` Azure request boundary for streamed PCM and resource-producing MP3. |

## How it works

A Speak click synchronously constructs and resumes a Web Audio `AudioContext`
with the interactive latency hint. In parallel, `RallyApi` sends the complete
stored markdown to the selected regional Worker with the current Rally session.
The Worker reduces markdown to readable plain text, preserving headings, lists,
code content, each link's name, and every collapsed section while dropping
formatting punctuation and every address: a named link is its name, and a bare
address is *link to* its registrable domain.

Azure accepts at most 4,096 characters in one speech request, so longer text is
split at paragraphs, sentences, lines, or words within that provider limit. The
Worker requests `gpt-4o-mini-tts`, the fixed `marin` voice, and raw 24 kHz
mono signed 16-bit little-endian PCM. It returns the first provider body directly
as a pull-driven `ReadableStream`; while those bytes play, it prepares at most
the next text chunk to avoid a gap between syntheses.

The renderer converts each complete two-byte sample as it arrives, carrying a
single trailing byte across network chunks when necessary. Each decoded buffer
is scheduled immediately after the prior buffer. Natural completion or Stop
cancels the fetch/provider stream, stops scheduled sources, closes the audio
context, and restores the button.

## Invariants

- **Speech receives the stored message string, never rendered DOM.** Collapsing
  a heading changes only presentation; otherwise Speak would silently omit the
  content the reader asked it to play.
- **A link is spoken by its name, never its address.** The reducer runs with
  `linkTargets: "spoken"`, so `[the plan](https://example.com/plan)` and a
  footnote's external source line both reach the provider as the words the
  model wrote, and a bare `https://www.apple.com/iphone/compare` reaches it as
  *link to apple.com*: the registrable domain, which `tldts` resolves, and
  nothing else of the address. A listener cannot follow a spoken address, and
  a voice spelling one out is noise between the words that matter; the
  text-only email part keeps the address because a reader there can follow it.
  An image with no alt text is spoken as *image*. An address inside a code
  span or an indented code block is code and is read as written, as fenced
  code already was.
- **Audio is never buffered into a complete file.** Waiting for MP3 generation
  or the full response would turn a listening action into a generation wait and
  destroy time-to-first-audio.
- **Only one message speaks at a time.** Starting another cancels the current
  fetch and Web Audio graph; overlapping agent voices make neither intelligible.
  The provider is that mutex for the window: the action row and the message-text
  menu both call `speak` / `stop` on it, so they cannot play over each other.
- **Each PCM player is single-use.** Stop closes its AudioContext; replay creates
  a fresh player instead of trying to resume a closed browser audio graph.
- **The renderer never receives the Azure credential.** It holds only its Rally
  session and calls the protected regional endpoint; moving the provider request
  client-side would expose production inference authority.
- **The control is named once.** Its visible label is *Speak*, and its
  accessible name and its tip are both *Speak response* — one string, spent
  twice by the action row's `MessageAction`, which
  [`conversation-surfaces.md`](conversation-surfaces.md) describes. A second
  string for the same button is how this control ended up saying two different
  things at once before. The message-text menu uses that same accessible name
  on an assistant body and *Speak* on a human body, because those words are
  not a Rally response.

## Boundary

This module owns on-demand playback of an existing assistant message. It does
not create a durable audio resource; the agent's `generate_audio` tool and
resource lifecycle are documented in [`agent-attachments.md`](agent-attachments.md).
It borrows the plain-text Markdown reduction owned by the digest/email renderer
([`digests.md`](digests.md)), asking it to drop link addresses, but neither
changes stored markdown nor owns how it is displayed; that remains
[`markdown-rendering.md`](markdown-rendering.md).

The route is REST because a person explicitly requests one potentially large
response body. It does not join the work-stream socket or Durable Object path;
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md) owns that transport
decision.

## Failure modes and limits

- **Nothing in the transcript says the voice is synthetic.** The name used to
  ("Speak response with an AI-generated voice") and no longer does; the visible
  label never did. A reader who has not played a message cannot learn from this
  surface that what plays is generated. The agent's `generate_audio` tool
  discloses its own output, but that is a different path and does not cover
  this one. Closing this needs somewhere of its own — the speech section of
  Settings, or a note on first play — because the control's one string is
  spoken for.
- Missing Azure inference configuration returns a user-safe 503 and logs no
  message content. Provider rejection before the first byte becomes the normal
  Rally API error; a later provider failure terminates the audio stream.
- Azure's 4,096-character input limit applies per provider request, not per
  Rally message. Rally keeps splitting until it has covered the complete text.
- Stop may discard one already-prefetched Azure chunk. Prefetch is intentionally
  limited to one; this is the accepted cost of avoiding silence between chunks.
- Azure's streaming response does not report usage or a price. Rally does not
  deny playback or invent a charge; `message_speech_billing_unavailable` is
  logged for the missing evidence.
- Malformed odd-length PCM fails playback instead of manufacturing the final
  half-sample. Errors are logged without the markdown and the action returns to
  Speak.

## Testing

`apps/api/test/message-speech-service.test.ts` proves the protected route,
complete Markdown reduction, that a link reaches the provider as its name with
no address, natural Unicode-safe splitting, ordered streaming, and disconnect
cancellation. `apps/desktop/src/renderer/lib/api.test.ts` proves
authenticated streaming without buffering;
`apps/desktop/src/renderer/lib/pcm-speech-player.test.ts` proves sample decoding;
and `apps/desktop/src/renderer/components/workstream-blocks.test.tsx` proves a
collapsed response sends the exact full markdown and exposes the Speak/Stop
state. `speech-playback.test.tsx` proves a second Speak stops the clip that is
already playing. Run them with:

```sh
pnpm --filter @rally/api exec vitest run test/message-speech-service.test.ts
pnpm --filter @rally/desktop exec vitest run \
  src/renderer/lib/api.test.ts \
  src/renderer/lib/pcm-speech-player.test.ts \
  src/renderer/components/speech-playback.test.tsx \
  src/renderer/components/workstream-blocks.test.tsx
```

The action row must also be inspected in a real Electron window; jsdom cannot
prove that the label fits, remains visible while speaking, or is not covered.

## Regional impact

The desktop calls the API region selected by the workspace. configured deployments each
use their own configured Azure inference endpoint and secret, and message text
does not cross Rally regions or enter a Durable Object. The same code supports a
future West production endpoint through that regional Worker configuration.

## Security and trust model

Message markdown and Azure bytes are untrusted. The API accepts one strict JSON
field behind `requireAuth`, never logs its contents, and emits a fixed audio
format. The renderer validates that format before handing bytes to the PCM
decoder. Playback uses an in-memory stream, not a provider URL, object URL,
preload capability, or relaxed `media-src` policy.

## Operations

`message_speech_stream_started` records region, request/workspace correlation,
model, provider chunk count, and setup time without content. Pair it with
`message_speech_billing_unavailable` when accounting for calls whose provider
response supplied no usage evidence. Provider failures flow through the normal
request error log with the request id.

## Performance and cost

Raw PCM is larger than compressed audio but needs no file completion or decode
phase, so it is the lowest-latency supported response format. The Worker honors
stream backpressure and keeps only the current provider reader plus one
prefetched provider promise. That prefetch can synthesize one chunk a person
later stops before hearing; prefetching the entire response was rejected because
its abandoned cost grows with message length.

### 2026-10-17 — Speak reads a link's name and not its address

**What changed:** The speech service asks the shared plain-text reducer for
`linkTargets: "spoken"`. `[the plan](https://example.com/plan)` reaches
`gpt-4o-mini-tts` as *the plan*, a footnote's external source line as its title
alone, and a bare `https://www.apple.com/iphone/compare`, `<https://…>` or
`www.…` as *link to apple.com*, and an image with no alt text as *image*;
before, every address was read out in full.

**Why:** The reducer was written for the text-only email part, where the address
beside a label is the reader's only way to follow the link. A listener cannot
follow a spoken address, and a voice reading one out is long, unintelligible,
and sits between the words that matter. A bare address has no name to speak in
its place, so it is announced as a link and named by the one part of it a
listener recognizes, the domain.

**Considered and rejected:** Stripping the parentheses in the speech service
after the reduction. That is a second regular expression that has to agree with
the reducer about what a link is, and the Sources list the citation pass appends
would have needed it too; it also could not tell an address in prose from one
inside a code span once the backticks are gone. Also rejected: a speech-only
reducer, which duplicates the heading, list, fence and citation handling to
change one choice. The option sits on the primitive, beside the `sources`
choice the citation rewrite already offers for the same reason. For the domain,
the full host (*docs dot github dot com*) and a guess at the last two labels
were both rejected: a listener gains nothing from a subdomain, and `bbc.co.uk`
defeats the guess. `tldts`, which the favicon and terminal network-policy
services already use, answers it. Speaking an unnamed image's full address, so
that two images on one host stay distinguishable, was rejected too: a path
spelled out is the noise this change removes.

**Consequences:** A new spoken surface passes the same option. An address inside
a code span or an indented code block is read as written, because it is code;
the spoken text is the one mode that takes an indented block verbatim, since
the email text part has always reduced its inline marks and is left that way.
Any scheme other than `http(s)` is read as written too. The domain honours the
Public Suffix List's private section, unlike the favicon and network-policy
callers, so `rally.github.io` is heard as the site and not as `github.io`. An image with no alt text is spoken as
*image*, as a screen reader names an unlabelled graphic; its address was all it
had.

Shipped in [#1278](https://github.com/juno-ai-labs/avalon/pull/1278).

### 2026-09-16 — Speak from the message menu uses the same one-voice mutex

**What changed:** The feed message's right-click Speak / Stop speaking is the
same toggle as the action row: same stored markdown, same
`SpeechPlaybackProvider`. Starting a second clip — from another turn or from
the other control — stops the one that is playing. A streaming assistant
body has no Speak item. A human body's item is named *Speak*. A failed
`prepare()` or `play()` aborts the in-flight `/speech` request.

**Why:** A second speech entry point without the existing mutex would play two
voices over each other. OS Speech was the alternative, and it would have been
a second engine as well as a second lock. Speaking a partial stream would
read a truncated snapshot the action row never offered. *Speak response* on
a member's own turn is the row's sentence for the assistant.

**Considered and rejected:** A separate player for the menu, or calling
Electron `startSpeaking`. Either one breaks the one-voice rule the action row
already had. Also rejected: leaving Speak on the streaming body and letting
later tokens join the player — the PCM player is single-use and the request
is the stored markdown at click time.

**Consequences:** Any new Speak control has to call this provider. A second
`SpeechPlaybackProvider` in the same window would be a second mutex.

### 2026-09-10 — Speak says *Speak response*, and the AI disclosure leaves with the native title

**What changed:** Speak's `title` attribute is gone; its tooltip is now the
app's own, opened by the action row's `MessageAction` from the same string as
the accessible label. That one string is now *Speak response* (and *Stop
speaking* while it plays). It had been *Speak response with an AI-generated
voice*.

**Why:** The row's other actions gained tooltips, and a native `title` beside
them would have opened in a different box, after a delay nothing in the app
sets, and never for a pointer already moving along the row. It also let the
disclosure exist twice in slightly different words: the label said *Speak
response with an AI-generated voice* and the title *Play with an AI-generated
voice*, which is exactly the drift a disclosure invariant should not permit.
The shortening was asked for directly: the row's five sentences are read
together on hover, and this was the only one that ran past its neighbours —
*Copy response*, *Save response as an image*, *Save response as a PDF*, *New
substream from this message*.

**Considered and rejected:** Splitting name from tooltip, so the tooltip could
stay short while the name kept the disclosure. `MessageAction` deliberately
spends one string on both, and two strings for one control is exactly the drift
that put two different disclosures on the same button before this.

**Consequences:** The disclosure is one string: changing what Speak says means
changing `description` on its `MessageAction`, and the label and the tooltip
move together because there is nothing else to move. Nothing in the transcript
now says the voice is synthetic. The agent's `generate_audio` tool still
discloses its own output, but that is a different path and does not cover this
one. If the disclosure is wanted back it needs somewhere of its own — the
speech section of Settings, or a first-play note — because the label is now
spoken for.

### 2026-08-31 — Stopped PCM players fail explicit reuse

**What changed:** The PCM player now documents its single-use lifecycle and
rejects `prepare()` or `play()` after Stop with a descriptive error.

**Why:** Closing the AudioContext is the correct cleanup, but a future replay or
retry caller could otherwise reuse the stopped object and receive silent
no-op playback. The guard turns that lifecycle violation into a visible defect.

**Considered and rejected:** Keeping an AudioContext alive for reuse would make
ownership and cleanup ambiguous. Rally already constructs one player per Speak
attempt, so a reusable player adds state without serving the product flow.

**Consequences:** Any future replay path must create a new player, matching the
existing Speech playback provider.

### 2026-08-30 — Finished responses can stream an AI voice

**What changed:** Speak/Stop joined the assistant action row. Rally streams raw
PCM from Azure `gpt-4o-mini-tts`, schedules it incrementally in Web Audio, and
chunks the complete markdown-derived speech only at Azure's input boundary.

**Why:** A saved audio resource is the wrong interaction for listening to a
message in place, and waiting for a complete MP3 makes first audio arrive only
after generation ends. The response also cannot be taken from the visible DOM:
collapsed sections are presentation state, not a request to omit content.

**Considered and rejected:** Buffering MP3 through the existing audio-generation
tool would increase latency and create a durable resource the person did not ask
for. Calling Azure directly from the renderer would expose provider credentials.
Using the work-stream socket would mix an explicit one-shot response with the
proactive transcript transport and complicate cancellation.

**Consequences:** Raw PCM costs more bandwidth, and stopping may abandon one
prefetched provider chunk. Future playback formats must preserve immediate
streaming, complete-source semantics, one-active-message cancellation, regional
authentication, and explicit AI-voice disclosure.

Shipped in the pull request for this change.
