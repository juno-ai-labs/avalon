# End-to-end verification

## Automated local smoke

Start from a migrated and seeded local database:

```text
pnpm db:migrate
pnpm db:seed
pnpm dev:api
pnpm smoke:local
```

The smoke check signs in through development-only authentication, verifies protected workspace routes, validates the right-rail fixtures and persisted tool transcript, replays a human message without duplicating agent work, rejects a private-network web monitor, receives a realtime snapshot, and rejects reuse of the single-use socket ticket. It does not create provider data or send email.

Set `AVALON_SMOKE_BASE_URL` to exercise another local Worker port. The command intentionally cannot authenticate against a hosted production Worker because development authentication must be disabled there.

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

## Desktop signup, invitations, and settings

1. Start from an empty desktop profile. Enter an organization name, verify both Global and European Union selectors change the target API, and create a development workspace or complete Google sign-in in a provider test account.
2. During Google sign-in, confirm the system browser visits `/auth/desktop/`, its address bar is stripped of the fragment, and the **Open Avalon** fallback returns the app to the correct regional session. Confirm the renderer never receives a Google code, token, or native PKCE verifier; relaunching the app before ticket redemption must require starting sign-in again.
3. Open an invitation while signed out and confirm its organization, email, role, and region preview through the issuing regional API. Complete sign-in and accept it once; reuse must fail.
4. While signed into a Global organization, open an EU invitation. Confirm the current session is not retargeted, the preview still uses the EU API, and the app requires sign-out before continuing with the invited account. Closing the invitation must restore the Global session route.
5. Open **Avalon → Settings…** and press **Command-,**. Confirm both paths focus the same Settings window and show account/session, version/platform/API/realtime diagnostics, immutable region, members, and role-appropriate invitation controls.
6. Create an invite as an owner/admin and confirm the UI reports **Invitation emailed** only after Resend accepts the request. Verify the message is from `Avalon <invites@with-avalon.com>`, contains the correct organization, role, region, seven-day expiry, and one-time link, then copy the same link from Settings as a fallback.
7. Install a workspace Google Drive connection, open a fresh work stream as another active member, and confirm Drive search plus every granted Docs/Sheets read and write tool is offered without attaching a resource. Confirm another member’s personal Google connection remains unavailable and a workspace automation still receives only its explicitly bound capabilities.
7. Accept the emailed invitation with the matching Google identity, confirm it cannot be reused, then create another invitation and revoke it before opening the email. Confirm the revoked link fails and a non-admin cannot create or revoke invitations. Sign out from Settings and confirm both application surfaces return to onboarding.

## Realtime recovery acceptance

1. Open a work stream and confirm the first client frame is `subscribe` with `afterSequence: 0`, followed by one room snapshot rather than duplicate snapshots.
2. Disconnect after receiving an event and reconnect. Confirm the new socket subscribes with the last applied sequence and receives only newer buffered events.
3. Evict/restart the room or exceed its replay window. Confirm it returns `resync_required`, the desktop refreshes canonical work stream/transcript/list queries, and no event is applied twice.
4. Leave the socket idle through at least two jittered heartbeat intervals. Confirm exact text `ping` receives `pong` through Cloudflare auto-response and does not require application-level room work.
5. Simulate a missing `pong`, offline/online transitions, and a burst of reconnecting clients. Confirm the desktop closes the stale socket, applies capped jittered backoff, resumes immediately when online, and keeps the last cursor.
6. Attempt an upgrade without `Origin`, from an unconfigured origin, and with an allowed-origin suffix lookalike. Confirm all are rejected; then connect from the exact desktop or development origin with a fresh ticket.

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

Use a publicly reachable test page whose response body can be changed between two known versions; private and loopback addresses must be rejected.

1. Create **Check this blog every 24 hours** from natural language and review the compiled interval before creation.
2. Bind a Web Monitor connection to the public page and create the automation.
3. Run it manually. Confirm exactly one run work stream, a successful fetch tool event, an R2-backed snapshot reference, and a completed gray work-stream state.
4. Retry the same manual-run request with its original idempotency key. Confirm the existing run and work stream are returned and no second harness launches.
5. Change the test page, invoke the connector poll, and wait for the normalized activity to pass through the activity Queue.
6. Confirm a new automation run uses the next planned work stream, the changed snapshot is retained, and the following recurrence remains scheduled.

Pass evidence: two distinct snapshots, one initial manual run, one change-triggered run, no duplicate for the manual retry, and no fetch of a private-network redirect target.

## PRD flow 3 — Google activity

Run this only in provider test accounts after enabling the five Google APIs and registering the OAuth callback URLs in `docs/PROVIDER_APPS.md`. If the OAuth client already has grants for the test account, revoke the old test grant or inspect the authorization request directly; Google's incremental-consent screen may summarize scopes granted during an earlier connection.

### Mail + Calendar preset

1. In Settings, choose **Google Mail + Calendar** and confirm the Avalon authorization request contains only `gmail.read`, `gmail.draft`, `gmail.send`, `calendar.read`, and `calendar.write` plus identity scopes. It must not request Drive, Docs, or Sheets capabilities.
2. Exercise `google.gmail.search`, `google.gmail.read_thread` or `google.gmail.read_message`, and `google.gmail.create_draft`. Confirm the draft is present in the provider account, the tool event stores a provider operation reference, and the returned content is bounded/redacted. Do not call `google.gmail.send` during a production smoke test.
3. Exercise `google.calendar.list_calendars`, then use an explicit returned calendar ID with `google.calendar.list_events`, `google.calendar.read_event`, `google.calendar.create_event`, and `google.calendar.update_event` against a clearly named disposable event.
4. Establish Gmail and Calendar poll baselines, then create a new test message and modify the test event. Run the owning connector poll and confirm normalized `email.received`/`email.updated` and `calendar.event_changed` activity is persisted and queued before its cursor advances.
5. Bind a personal automation to the connection and confirm one activity creates one authorized work stream with visible tool events. Confirm a Docs or Sheets tool is rejected because this connection does not hold those capabilities.

### Drive + Docs + Sheets preset

1. In Settings, choose **Google Drive + Docs + Sheets** and confirm the Avalon authorization request contains only `drive.read`, `docs.read`, `docs.write`, `sheets.read`, and `sheets.write` plus identity scopes. It must not request Gmail or Calendar capabilities.
2. Exercise `google.drive.search` and `google.drive.get_metadata` against a disposable fixture; also verify one bounded `google.drive.download` or `google.drive.export` result.
3. Exercise the native Docs tools: create a document with `google.docs.create_document`, read it with `google.docs.read_document`, append text with `google.docs.append_text`, and replace an exact fixture string with `google.docs.replace_text`.
4. Exercise the native Sheets tools: create a spreadsheet with `google.sheets.create_spreadsheet`, inspect it with `google.sheets.read_spreadsheet`, write an explicit A1 range with `google.sheets.update_values`, append rows with `google.sheets.append_values`, and read the result with `google.sheets.read_values`.
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

## Provider and deployment note

Flows 2 and 3 require external services and are release gates for a hosted test workspace, not for an offline local build. Follow the regional deployment checklist in `docs/RUNBOOK.md`; production smoke should create a Gmail draft unless an explicit send has been approved.
