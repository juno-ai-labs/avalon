# End-to-end verification

## Automated local smoke

Start from a migrated and seeded local database:

```text
pnpm db:migrate
pnpm db:seed
pnpm dev:api
pnpm smoke:local
```

The smoke check signs in through development-only authentication, verifies protected workspace routes, validates the right-rail fixtures and persisted tool transcript, replays a human message without duplicating agent work, receives a realtime snapshot, and rejects reuse of the single-use socket ticket. It does not create provider data or send email.

Set `AVALON_SMOKE_BASE_URL` to exercise another Worker. Local Workers use the development session endpoint; hosted production smoke tests must also set a short-lived `AVALON_SMOKE_ACCESS_TOKEN` because development authentication remains disabled in production.

## Right-sidebar and desktop acceptance

Run the Electron desktop with `pnpm dev:desktop` and exercise these flows against the local Worker:

1. Open **Investigate ENG-142** and confirm the right sidebar opens to **Background** with the three persisted task cards.
2. Filter between all, running, and finished tasks; open a transcript link; close and reopen the rail.
3. Switch to **Context**, confirm participants and current viewers are distinct, then open the resource detail.
4. Turn the resource watch off and on, confirm the state survives a detail refresh, and remove a resource only after the explicit action.
5. Expand and collapse the rail and resize it through its 320–560 pixel range. At a narrow window width, confirm the rail overlays the transcript without hiding its close control.
6. Open **New automation**, verify that required capabilities must each be bound to a healthy connection, and browse workspace templates without exposing the regular work-stream composer.
7. Send a human-only acknowledgment and confirm no agent run starts; then submit an actionable request and confirm streaming/tool events appear once despite reconnects.
8. Mention a workspace member who is not participating and confirm that no participant is added until the person accepts the confirmation prompt.
9. Type `@` mentions in the composer and confirm each participant or connection Avalon recognizes is highlighted in the brand color as soon as its full name is typed or picked, while half-typed and unknown handles stay plain. Confirm the highlight tracks the caret, wrapping, and scrolling exactly, and that an IME composition still shows its in-flight text.
10. Send that message and confirm the transcript keeps the same brand treatment: the person mention becomes an avatar chip and the connection mention becomes a label chip, both in the brand color, in human and agent messages alike. Confirm neither chip navigates, and that a connection named in text without a stored mention range stays plain.
11. With a screenshot on the clipboard, paste into the composer of a work stream, of **New work stream**, and of an automation draft. Confirm each paste becomes an uploading attachment tile named `Pasted image <date> at <time>` instead of pasting text, that the typed draft and the caret are untouched, and that pasting the same screenshot twice reports one skipped duplicate. Paste again **without clicking the composer first** — straight after the work stream opens, and with the transcript focused — and confirm it still attaches, then confirm a paste into the resource search field and into an open dialog still pastes as text there. Copy a range of spreadsheet cells and confirm the paste inserts the text with no attachment; copy a file in Finder and confirm it attaches under its own name; copy a passage containing an inline image and confirm the text lands at the caret *and* the image attaches.
12. Force the work-stream detail request to fail — a route such as `#/workstreams/does-not-exist` is enough — and confirm **Work stream could not be opened** offers **Copy work-stream ID** from the top-right menu alongside **Try again**. The copied value is the identifier from the route, which is the only one available once the detail payload has failed.

## Desktop signup, invitations, and settings

1. Start from an empty desktop profile. Enter an organization name, verify both Global and European Union selectors change the target API, and create a development workspace or complete Google sign-in in a provider test account.
2. During Google sign-in, confirm the system browser visits `/auth/desktop/`, its address bar is stripped of the fragment, and the **Open Avalon** fallback returns the app to the correct regional session. Confirm the renderer never receives a Google code, token, or native PKCE verifier; relaunching the app before ticket redemption must require starting sign-in again.
3. Open an invitation while signed out and confirm its organization, email, role, and region preview through the issuing regional API. Complete sign-in and accept it once; reuse must fail.
4. While signed into a Global organization, open an EU invitation. Confirm the current session is not retargeted, the preview still uses the EU API, and the app requires sign-out before continuing with the invited account. Closing the invitation must restore the Global session route.
5. Open **Avalon → Settings…** and press **Command-,**. Confirm both paths focus the same Settings window and show account/session, version/platform/API/realtime diagnostics, immutable region, members, and role-appropriate invitation controls.
6. Open **Application** and confirm **Developer → Debug enabled** sits below Appearance and is off. Right-click a work stream and an automation in the sidebar and confirm neither menu offers a copy-identifier action. Open a work stream's right rail and confirm **Details** lists only the work stream's address (if it has one), Created by, Created, and Last activity, with the address on one line. Turn the preference on and confirm both menus gain **Copy work stream id** / **Copy automation id** without reopening the main window, that each copies the resource's identifier, that **Details** gains the origin, automation, harness, and identifier rows in the same window, and that the choice survives a restart. Turn it off and confirm both actions and the extra rows disappear again.
7. Create an invite as an owner/admin and confirm the UI reports **Invitation emailed** only after Resend accepts the request. Verify the message is from `Avalon <invites@with-avalon.com>`, contains the correct organization, role, region, seven-day expiry, and one-time link, then copy the same link from Settings as a fallback.
8. Install a workspace Google Drive connection, open a fresh work stream as another active member, and confirm Drive search plus every granted Docs/Sheets read and write tool is offered without attaching a resource. Confirm another member’s personal Google connection remains unavailable and a workspace automation still receives only its explicitly bound capabilities.
9. For each OAuth connector, confirm the provider returns to `/auth/desktop/`, the page reports success or cancellation and offers **Open Avalon**, and Settings reaches the same terminal result when automatic app opening is blocked. Close Avalon before a successful callback, reopen it, and confirm the persisted connection appears without repeating authorization.
10. Accept the emailed invitation with the matching Google identity, confirm it cannot be reused, then create another invitation and revoke it before opening the email. Confirm the revoked link fails and a non-admin cannot create or revoke invitations. Sign out from Settings and confirm both application surfaces return to onboarding.

## Realtime recovery acceptance

1. Open a work stream and confirm the first client frame is `subscribe` with `afterSequence: 0`, followed by one room snapshot rather than duplicate snapshots.
2. Disconnect after receiving an event and reconnect. Confirm the new socket subscribes with the last applied sequence and receives only newer buffered events.
3. Evict/restart the room or exceed its replay window. Confirm it returns `resync_required`, the desktop refreshes canonical work stream/transcript/list queries, and no event is applied twice.
4. Leave the socket idle through at least two jittered heartbeat intervals. Confirm exact text `ping` receives `pong` through Cloudflare auto-response and does not require application-level room work.
5. Simulate a missing `pong`, offline/online transitions, and a burst of reconnecting clients. Confirm the desktop closes the stale socket, applies capped jittered backoff, resumes immediately when online, and keeps the last cursor.
6. Attempt an upgrade without `Origin`, from an unconfigured origin, and with an allowed-origin suffix lookalike. Confirm all are rejected; then connect from the exact desktop or development origin with a fresh ticket.

## Desktop dictation acceptance

Configure the regional Worker with an Azure OpenAI realtime deployment backed by `gpt-live-transcribe`, then run the Electron desktop against that Worker.

1. Open a work stream and confirm the live-update dot appears in the top-right action bar, no longer appears in the composer, and describes each connected, connecting, reconnecting, and unavailable state in its tooltip. With a screen reader, confirm each state transition is announced from the live region.
2. Confirm the microphone control appears immediately after the file button. Hover it and verify the tooltip reads **Click or hold to dictate**.
3. Open the adjacent arrow menu, select a non-default audio input, close and reopen the menu, and confirm the selection remains checked and is exposed as the checked radio item to assistive technology. Restart before granting microphone permission and confirm the saved selection is not erased. Confirm the menu contains no recording-mode toggle.
4. Click the microphone, speak, then click it again. Confirm the transcript is appended to the draft without sending the message and incoming deltas do not move keyboard focus away from the Stop control. Repeat by holding the microphone for at least 350 ms and releasing it to stop.
5. Deny microphone access and confirm Avalon reports a recoverable permission error. Grant access in macOS System Settings, restart dictation, and confirm it succeeds without granting camera or display-capture permission.
6. Inspect the renderer and Worker traffic. Confirm the desktop connects only to Avalon's short-lived transcription socket, the Worker opens Azure's `intent=transcription` socket, and no Azure endpoint, deployment, or API key reaches the renderer or logs.
7. Reuse a consumed transcription socket URL and confirm it is rejected. Open two active recordings for one user and confirm a third is rejected; after closing one, confirm a fresh ticket can connect.
8. Stop and immediately restart while the first permission or ticket request is still pending. Resolve the older request last and confirm it cannot reopen a microphone, socket, or overwrite the new draft.
9. After Stop, deliver a transcript delta followed by a corrected completion event. Confirm the partial remains visible and Avalon waits for the completion before closing. While it waits, edit the draft or activate **Cancel dictation** and confirm the pending finalization ends immediately without overwriting the edit. Switch work streams during recording and confirm the old capture stops instead of writing into the new draft.

## PRD flow 1 — ad hoc collaboration

Use a test workspace with two members, Adam and Samantha.

1. Sign in and create **CFO of Calm** with Samantha selected before submission.
2. Confirm both people appear under **People** in the right rail and Avalon does not.
3. Send an opening instruction and observe a real OpenRouter response stream into the transcript.
4. Attach a small text or PDF file, open **Context**, and confirm the resource appears without exposing storage identifiers or credentials.
5. Open the same work stream as a third workspace member. Confirm **Viewing now** shows that person separately and does not add a participant row.
6. Reload both clients and confirm the transcript, people, and resource remain durable while viewing presence disappears when the second client closes.

Pass evidence: one work stream, two persistent participants, no Avalon participant, one persisted attachment, one completed harness run, and no participant row for the viewer.

## PRD flow 2 — recurring web automation

Use a stable public topic with authoritative sources, such as a cloud provider's model-release catalog.

1. Create **Check for new model releases every 24 hours** from natural language and review the compiled interval before creation.
2. Confirm the automation requires the `avalon:web` plugin and no connector binding.
3. Run it manually. Confirm exactly one run work stream, successful `web_search` and selected `web_fetch` tool events, source-linked output, and a completed gray work-stream state.
4. Retry the same manual-run request with its original idempotency key. Confirm the existing run and work stream are returned and no second harness launches.
5. Let the next recurrence become due and confirm it creates the next planned work stream while preserving the following schedule.

Pass evidence: one initial manual run, one scheduled recurrence, authoritative source links, and no duplicate for the manual retry.

## PRD flow 3 — Google activity

Run this only in provider test accounts after enabling the five Google APIs and registering the OAuth callback URLs in `docs/PROVIDER_APPS.md`. If the OAuth client already has grants for the test account, revoke the old test grant or inspect the authorization request directly; Google's incremental-consent screen may summarize scopes granted during an earlier connection.

### Mail + Calendar preset

1. In Settings, choose **Google Mail + Calendar** and confirm the Avalon authorization request contains only `gmail.read`, `gmail.draft`, `gmail.send`, `calendar.read`, and `calendar.write` plus identity scopes. It must not request Drive, Docs, or Sheets capabilities.
2. Exercise `google_gmail_search`, `google_gmail_read_thread` or `google_gmail_read_message`, and `google_gmail_create_draft`. Confirm the draft is present in the provider account, the tool event stores a provider operation reference, and the returned content is bounded/redacted. Do not call `google_gmail_send` during a production smoke test.
3. Exercise `google_calendar_list_calendars`, then use an explicit returned calendar ID with `google_calendar_list_events`, `google_calendar_read_event`, `google_calendar_create_event`, and `google_calendar_update_event` against a clearly named disposable event.
4. Establish Gmail and Calendar poll baselines, then create a new test message and modify the test event. Run the owning connector poll and confirm normalized `email.received`/`email.updated` and `calendar.event_changed` activity is persisted and queued before its cursor advances.
5. Bind a personal automation to the connection and confirm one activity creates one authorized work stream with visible tool events. Confirm a Docs or Sheets tool is rejected because this connection does not hold those capabilities.

### Drive + Docs + Sheets preset

1. In Settings, choose **Google Drive + Docs + Sheets** and confirm the Avalon authorization request contains only `drive.read`, `docs.read`, `docs.write`, `sheets.read`, and `sheets.write` plus identity scopes. It must not request Gmail or Calendar capabilities.
2. Exercise `google_drive_search` and `google_drive_get_metadata` against a disposable fixture; also verify one bounded `google_drive_download` or `google_drive_export` result.
3. Exercise the native Docs tools: create a document with `google_docs_create_document`, read it with `google_docs_read_document`, append text with `google_docs_append_text`, and replace an exact fixture string with `google_docs_replace_text`.
4. Exercise the native Sheets tools: create a spreadsheet with `google_sheets_create_spreadsheet`, inspect it with `google_sheets_read_spreadsheet`, write an explicit A1 range with `google_sheets_update_values`, append rows with `google_sheets_append_values`, and read the result with `google_sheets_read_values`.
5. Establish the Drive change-token baseline before editing the Doc and Sheet. After both edits, run the connector poll and confirm the same Drive poll emits `docs.document_changed` and `sheets.spreadsheet_changed`, persists/queues them once, and then advances the Drive cursor. No Google webhook or push delivery should be involved.
6. Bind an automation to this connection and confirm Gmail and Calendar tools are rejected because the connection does not hold those capabilities.

Finally, revoke a test provider grant and repeat an affected read. Confirm the connection changes to **Reconnect required**, dependent work stops safely, and no token or raw provider response body appears in the desktop or logs.

Pass evidence: two independently selectable preset connections, exact stored capability sets, bounded native Docs and Sheets operations, Mail/Calendar and Drive cursors, one Drive-derived Doc activity, one Drive-derived Sheet activity, one authorized automation run per tested connection, and a sanitized reconnect state. Sending email is not required for this flow.

## PRD flow 4 — contextual routing

1. Create a long-lived **CFO of Calm** work stream with at least one participant.
2. Create a signed generic-webhook connection and ingest a transcript activity mentioning Calm and the CFO search.
3. Confirm deterministic filtering and the bounded classifier produce a suggestion card inside that work stream rather than silently attaching the activity.
4. Confirm the suggestion moves the work stream up by activity time but merely opening it as another member does not add that viewer as a participant.
5. Accept the suggestion. Confirm the transcript resource is hydrated, attached once, and available to a subsequently requested harness loop.
6. Repeat the same signed delivery identifier and confirm ingestion reports a duplicate without creating a second activity, suggestion, or attachment.

Pass evidence: one activity, one suggestion before acceptance, one attached resource after acceptance, stable participant membership, and idempotent webhook replay.

## Flow 9 — inbound work-stream email

1. Create one Global and one EU work stream and confirm each exposes an immutable four-segment address at `automation.with-avalon.com`.
2. Send plain text to both addresses. Confirm one verified `email.received` event creates one regional email resource and one system transcript message in each target.
3. Replay the same Resend delivery and confirm no duplicate resource or message is created.
4. Send to an unknown alias and confirm the webhook is acknowledged without attaching it anywhere. Send HTML containing script-like content and confirm Avalon never renders or executes it.
5. Confirm the Global database does not contain the EU email body and that inbound mail does not automatically start an agent run.

## Flow 10 — inbound automation email

1. Create one Global and one EU automation and confirm each exposes a permanent four-segment address from the same account-wide namespace as work streams.
2. Send one message to each address. Confirm each owning region stores the untrusted email resource, creates exactly one new work stream and automation run, and passes only that labelled opening message to the harness.
3. Replay the same Resend email ID while processing and after completion. Confirm an active lease returns a retryable response, an expired lease can be reclaimed, and the completed replay returns the original work-stream and run IDs without launching again.
4. Pause an automation and confirm its route is disabled and mail cannot start a run. Resume it and confirm the exact same address is active again.
5. Confirm a work-stream reservation cannot claim an automation local part (or vice versa), even across regions, and that removing an owner leaves a permanent tombstone.

## PRD flow 5 — future scheduled run

1. Create a Monday calendar automation in a timezone with daylight-saving transitions and open its next planned run from the automation screen.
2. Post pre-run instructions. Confirm the posting user becomes a participant and the work stream remains **Scheduled**.
3. Fire the workspace scheduler for that planned time, including one repeated alarm delivery.
4. Confirm the same planned work stream becomes **Running**, exactly one automation run and harness run are linked, and the pre-run message is included in the bounded model context.
5. Complete the run and confirm the next planned work stream uses the correct local Monday time across the next daylight-saving boundary.

Pass evidence: the planned work-stream ID is reused, the uniqueness key on subscription plus planned time prevents a duplicate, pre-run context reaches the harness, and the next local occurrence is correct.

## Flow 11 — Slack Agent connector

1. Validate `config/provider-apps/slack.json` with Slack CLI 4.4.0 or later and install the development app in two Slack test workspaces.
2. Connect both Slack installations to one Avalon workspace. Confirm two `Slack · <team>` workspace connections exist and each bot durably joins every existing public channel. Reconnect one installation and confirm the idempotent sync runs again. Attempt to connect either Slack team to a different Avalon workspace and confirm `slack_workspace_already_connected`.
3. Open each app Home as an unlinked user. Confirm onboarding, privacy/help, and a unique expiring link. Link one Avalon member and confirm Home changes to quick actions, active tasks, automations, and notifications.
4. Create a public Slack channel and confirm the `channel_created` ingress job makes Avalon join it. Send a new Agent DM, a threaded follow-up, and a channel mention. Confirm Avalon adds `👀` to each exact triggering message before a workstream or model run starts, each root maps to one `slack_agent_sessions` row, follow-ups reuse the workstream, status appears, and completion stops the stream or posts the fallback thread reply. Replay a claimed job after the reaction succeeds and confirm Slack's `already_reacted` response does not duplicate or fail the task.
5. Mention one linked Avalon teammate and one unlinked teammate whose verified email matches exactly one active member across the installed Slack teams. Confirm both receive one bot-authored Agent DM and the unlinked teammate does not gain a `slack_user_links` record. Repeat with no match, matches in two teams, a cross-team result, and a missing `users:read.email` grant; confirm each falls back to the existing mention email, and the additive missing scope does not disable existing Agent features.
6. Invoke both shortcuts and `/avalon`; confirm the modal opens in under three seconds, submissions create tasks, and malformed/replayed signatures are rejected.
7. Redeliver the same Events API `event_id` and body; confirm it is acknowledged once. Reuse the ID with different bytes and confirm the conflict is recorded. Force the first regional worker attempt to fail and confirm the durable queue retries the same ingress job instead of permanently deduplicating the failed receipt.
8. From an Agent DM and an app mention, ask Avalon to find a message, identify a user/channel, read message/channel/thread/file/member context, and cite the returned permalink. Confirm `assistant.search.context` receives the event's `action_token`, public-only channel types, and a maximum of 20 results; confirm the token is absent from model prompts and tool arguments. Start the same search outside Slack with only the workspace connection and confirm it fails with a user-initiated-search explanation. Confirm specific reads still work without an action token when the bot can access the target conversation.
9. Ask Avalon to send a message, add a reaction, and create a public channel, a private channel, a DM, and a group DM through the workspace installation. Confirm the normal write confirmation/receipt gate, bot attribution, stable `client_msg_id` on messages, idempotent `already_reacted` handling, and no duplicate provider mutation after a workflow retry.
10. Add a personal Slack connection with read-only MCP capabilities. Confirm search/read tools appear only for that user. Reauthorize with one write capability, verify confirmation/receipt behavior, and confirm another Avalon member cannot use it.
11. Copy a work-stream link from the desktop header and confirm it is the canonical `https://with-avalon.com/app/workstreams/<uuid>`. Paste it into Slack and confirm the unfurl names the work stream — title, status, last activity, and automation origin where it has one — and reveals no work-stream contents. Paste a link to a work stream in another Avalon workspace and confirm the anonymous card. Repeat in a Slack Connect channel and confirm the anonymous card there too; confirm both still unfurl rather than being dropped. Then move the work stream to a new status, wait for the five-minute maintenance sweep, and confirm the posted card rewrites itself in place without adding a second attachment; confirm a card whose status has not moved is left alone. Open the link in a browser and confirm it hands off to the desktop app; open one with a malformed id and confirm the page says so instead of offering a dead button. Paste a legacy `/open#target=avalon://workstreams/<uuid>` link and confirm it still unfurls; paste a bare `avalon://workstreams/<uuid>` and confirm no unfurl is expected, since Slack delivers no event for it.
12. Create “Check my Gmail every morning and send me the stack-ranked top 3 emails in Slack,” select one Slack Agent DM destination, and inspect the stored frozen target. Run it with three, one, and zero qualifying emails. Confirm the complete ranked Slack output and controls, fewer-than-three behavior, and default empty suppression.
13. Revoke Gmail, then Slack. Confirm each run/destination moves to `needs_input`; no alternate account or Slack installation is selected.
14. Repeat an Agent DM and automation delivery for an EU Avalon workspace. Confirm Global stores only the team route and the EU D1 owns links, sessions, workstreams, and results.
15. Expire a rotating Slack credential and start two simultaneous connector operations. Confirm exactly one `oauth.v2.*.access` refresh consumes the old refresh token and both operations continue with the newly persisted token pair.

## Provider and deployment note

Flows 2 and 3 require external services and are release gates for a hosted test workspace, not for an offline local build. Follow the regional deployment checklist in `docs/RUNBOOK.md`; production smoke should create a Gmail draft unless an explicit send has been approved.
