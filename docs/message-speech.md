# Speaking a message

Every finished Rally response has a **Speak** action that reads the complete
message with an AI-generated voice. Playback starts from a regional,
authenticated PCM stream and the action becomes **Stop speaking** until the
stream finishes or the person stops it.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` | The icon-and-text action under a finished response; it always passes the stored markdown, not the visible collapsed DOM. |
| `apps/desktop/src/renderer/components/speech-playback.tsx` | The one-active-message lifecycle, immediate AudioContext activation, cancellation, and failure logging. |
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
code content, links, and every collapsed section while dropping formatting
punctuation.

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
- **Audio is never buffered into a complete file.** Waiting for MP3 generation
  or the full response would turn a listening action into a generation wait and
  destroy time-to-first-audio.
- **Only one message speaks at a time.** Starting another cancels the current
  fetch and Web Audio graph; overlapping agent voices make neither intelligible.
- **Each PCM player is single-use.** Stop closes its AudioContext; replay creates
  a fresh player instead of trying to resume a closed browser audio graph.
- **The renderer never receives the Azure credential.** It holds only its Rally
  session and calls the protected regional endpoint; moving the provider request
  client-side would expose production inference authority.
- **The UI discloses the AI voice.** The button's accessible label and tooltip
  identify it as AI-generated, even though the compact visible label remains
  Speak.

## Boundary

This module owns on-demand playback of an existing assistant message. It does
not create a durable audio resource; the agent's `generate_audio` tool and
resource lifecycle are documented in [`agent-attachments.md`](agent-attachments.md).
It borrows the plain-text Markdown reduction owned by the digest/email renderer
but neither changes stored markdown nor owns how it is displayed; that remains
[`markdown-rendering.md`](markdown-rendering.md).

The route is REST because a person explicitly requests one potentially large
response body. It does not join the work-stream socket or Durable Object path;
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md) owns that transport
decision.

## Failure modes and limits

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
complete Markdown reduction, natural Unicode-safe splitting, ordered streaming,
and disconnect cancellation. `apps/desktop/src/renderer/lib/api.test.ts` proves
authenticated streaming without buffering;
`apps/desktop/src/renderer/lib/pcm-speech-player.test.ts` proves sample decoding;
and `apps/desktop/src/renderer/components/workstream-blocks.test.tsx` proves a
collapsed response sends the exact full markdown and exposes the Speak/Stop
state. Run them with:

```sh
pnpm --filter @rally/api exec vitest run test/message-speech-service.test.ts
pnpm --filter @rally/desktop exec vitest run \
  src/renderer/lib/api.test.ts \
  src/renderer/lib/pcm-speech-player.test.ts \
  src/renderer/components/workstream-blocks.test.tsx
```

The action row must also be inspected in a real Electron window; jsdom cannot
prove that the label fits, remains visible while speaking, or is not covered.

## Regional impact

The desktop calls the API region selected by the workspace. Global and EU each
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

## Changelog

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
