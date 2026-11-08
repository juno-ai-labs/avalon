# End-to-end verification

This document covers the checks that need a running system: the local smoke
script and the manual desktop flows. The automated suites — where a unit or
integration test belongs, which runtime it runs on, and why the default is the
real Cloudflare pipeline rather than a double — are in
[`testing.md`](testing.md).

## Automated local smoke

Start from a migrated and seeded local database:

```text
pnpm db:migrate
pnpm db:seed
pnpm dev:api:local            # opens the authority and imports the seeded Canvases
pnpm smoke:local
```

The smoke check signs in through development-only authentication, verifies
protected workspace routes and the invitation lifecycle, and reads the seeded
fixtures from `packages/db/seed-product.json`: the Launch plan Canvas's
artifact, the Q4 revenue review Chat's turns and reply, and the Weekly
changelog Sidekick's shared conversation. It then makes a Canvas under an id
it minted (`POST /canvases`), checks that a retried create answers the same
Canvas and that a message resent to its Chat
(`POST /conversations/:id/substreams/0/messages`) lands once, and, when
`/health` reports OpenRouter configured, waits for Rally's reply there; without
a model its summary line says the reply was not checked. Last, it replays the
seeded opening message over the Chat's conversation socket without duplicating
it, receives its private command receipt, and rejects reuse of the single-use
socket ticket. It does not create provider data or send email.

Set `AVALON_SMOKE_BASE_URL` to exercise another Worker. Local Workers use the development session endpoint; hosted production smoke tests must also set a short-lived `AVALON_SMOKE_ACCESS_TOKEN` because development authentication remains disabled in production. A hosted Worker serves the model its `agent-model-workstream` flag names, which can differ from the checked-in default; set `AVALON_SMOKE_EXPECTED_MODEL` to that model.

## Automated behavioral lane

`pnpm e2e:local` drives the running local stack through the same REST bootstrap
and conversation command socket the desktop client uses. Every scenario makes a
Canvas under an id it minted (`POST /canvases`) and sends its opening message
to the Canvas's Chat (`POST /conversations/:id/substreams/0/messages`), in
three lanes: **happy** paths that must produce an agent reply
(create-and-reply, follow-up, stop, transcript ordering, an artifact
published), **sad** paths that must be refused safely (auth, validation, an
oversize message, idempotent replays, missing targets), and **chaos** paths
that must not corrupt or wedge anything (concurrent bursts, and concurrent
creates each beside a retry of its own id, which must answer the same Canvas).
Counts and concurrency are arguments:

```text
pnpm db:migrate && pnpm db:seed
pnpm dev:api:local            # in another terminal
pnpm db:open-authority        # walk local D1 to durable_object_open + seed product fixtures
pnpm e2e:local -- --happy 10 --sad 8 --chaos 2 --concurrency 4
```

`pnpm db:open-authority` matters: without it a fresh local database serves the
*legacy* path, and none of the Durable-Object-authority code runs — which is
how a defect that failed every production harness run stayed invisible to
every local check. The walk is idempotent, respects the production state
machine, and seeds the product fixtures into the Durable Objects through the Worker's
dev-only route, so `pnpm smoke:local` keeps passing on an opened
stack.

The lane **requires** a configured OpenRouter key by default: `/health` must
report the provider configured (an `OPENROUTER_API_KEY` in `.env.local`,
`pnpm env:sync`, and a Worker restart), and a run must complete with a reply.
Without a key it refuses to run rather than silently weakening — the no-model
oracle only proves "terminal and truthful", which cannot catch a run failing
before the provider for the wrong reason, the exact defect family this lane
exists for. `--allow-no-model` opts into that degraded oracle explicitly, for
credential-less environments. The oracles and the gate are unit-tested in
`scripts/e2e-local-oracles.test.mjs` — this lane's own first deployment
failed 34 stop scenarios because `idle` was missing from its terminal set, so
the pass conditions are treated as code that can rot.

**A dead Worker ends the run.** After any request the Worker answers with a
5xx or does not answer, the lane asks `/health` once; if the Worker is gone it
stops starting scenarios and its verdict is "the Worker died during
<scenario>", rather than running the rest into `fetch failed`. It does not
retry. On 2026-11-07, 2 of 8 full default runs killed the local workerd
(`wrangler dev` logged an empty error and "Network connection lost" in its
proxy worker, and no application error) at the chaos burst: 12 simultaneous
Canvas creates, then 6 simultaneous run starts, beside two runs streaming 500
lines and 6 socket commands. Both were the first runs against a freshly
migrated database; the other six passed 20 of 20. The burst sizes are the
team's to set; they were not lowered to make the lane pass.

The artifact scenario publishes through the Terminal, so it runs only when
`/health` reports a model and `GET /workspace/terminal` reports the Terminal
`supported`; otherwise the lane prints why it skipped it, per scenario and in
the summary line (`artifacts=skipped (…)`), rather than passing or failing it.
A local stack has no Daytona configuration, so locally it is skipped. The gate
and the oracle (`artifactGateDecision`, `artifactOutcomeOracle`) are in the
same oracle test.

This lane exists because it catches what the unit and workerd suites
structurally cannot: its first sustained run found a view trigger that crashed
every retried run's settlement, a creation path that never scheduled naming,
and a compound-SELECT limit under concurrent load. Follow-up messages,
idempotency replays, concurrent bursts, and Stop use the Chat's socket; the
opening message uses the REST admission route a command client uses.

## Lightbox and desktop acceptance

Resource checks use an open Canvas's right rail, or Resource details from an
artifact preview. Test the version menu, refresh and archive cancellation
there. Generated sites must use the isolated native viewer, not file
conversion. Route changes close previews; missing content shows an error
without a download action. Nested dialogs and menus must stay above native
content.

Run the Electron desktop with `pnpm dev:desktop` and exercise these flows against the local Worker:

1. Open the seeded **Launch plan** Canvas and confirm its newest artifact opens in the right rail. Open **Versions** from the artifact's header and confirm it is a dropdown over the document rather than a pane that replaces it. Open an image resource and confirm the picture itself is in the lightbox, not an empty last-updated panel. Archive a resource only after **Continue** on the confirm modal — the dialog stays until the unlink succeeds, and a refused request leaves the document open with the reason.
2. Sweep the pointer toward the navigation sidebar's trailing edge and confirm its pill appears once the pointer is within 20 pixels of the edge, at the top of the list and at the bottom alike, and that dragging it resizes the navigation.
3. Describe a Sidekick in **New Sidekick** and send one turn without finishing it, then return to the Sidekicks home and confirm a named draft appears, marked **Draft**, without an active Sidekick being created. Restart the client, open that draft, and confirm the wizard resumes on the turn it was left at, with the earlier messages above it and the wizard's question still answerable; answer it and confirm no second draft appears. Type an answer without sending it, switch to another Sidekick and back, and confirm the unsent text stayed with the draft it was typed in. Finish one draft and confirm the same row becomes the active Sidekick rather than leaving a second draft beside it. On another draft, open the overview header's **⋯** menu and confirm it offers **Archive draft**; confirm the dialog says the authoring conversation remains stored but will no longer be viewable, and that Rally does not offer a way to unarchive it yet. Cancel once and confirm the draft remains; then choose **Archive** and confirm the draft leaves the list and does not return after a restart. Open an active or paused Sidekick, open the same menu, and confirm it offers **Archive Sidekick**, names the Sidekick, says its schedules stop, and that choosing **Archive** removes it from the list, stops its next planned run, and rejects mail to its address while the address stays reserved. With the network refusing the archive, confirm the dialog stays open and says why instead of closing on a failure.
4. In a Sidekick's conversation, as a manager, switch **Edit Sidekick** on in the composer's menu and confirm the composer reads "Describe a change to this Sidekick…" and the heading says **Editing this Sidekick**; switch it off and send a request, and confirm a run row appears, collapsed, and opens the run's own read-only conversation with a way back.
5. In a Canvas's Chat with someone else present, send a human-only acknowledgment and confirm no agent run starts; then submit an actionable request and confirm streaming/tool events appear once despite reconnects. While it streams, scroll up one wheel tick and confirm the viewport stays exactly where you put it for the rest of the turn, that **Jump to latest** appears the moment it stops following, and that pressing it animates back to the newest message rather than cutting — unless the tester has the OS **Reduce Motion** setting on, in which case it must land at the newest message in one instant cut. Scroll back to the end by hand and confirm following resumes; scroll up inside a code block or an expanded tool output and confirm that alone does not stop it. Send a message while scrolled up and confirm the transcript returns to the end to show it. While its answer is streaming, open another Canvas and return: confirm the complete prefix is still present, new chunks continue in the same bubble, and neither text nor the scroll position flashes, duplicates, or jumps.
6. Type `@` mentions in the composer and confirm each workspace member Rally recognizes is highlighted in the brand color as soon as their full name is typed or picked, while half-typed and unknown handles stay plain. Confirm the popover walks with `ArrowUp`/`ArrowDown`, wrapping at both ends and scrolling the highlighted row into view, that `Enter` inserts the highlighted person rather than sending, that `Escape` dismisses it, and that the row under the pointer is the one `Enter` takes. With an IME active, confirm the `Enter` that commits a composition neither sends the message nor runs the slash command on display, and that a second `Enter` does. Send the message and confirm the person mention becomes an avatar chip in the brand color, in human and agent messages alike, and that the chip does not navigate.
7. With a screenshot on the clipboard, paste into a Canvas's composer and a Sidekick draft's. Confirm each paste becomes an uploading attachment tile named `Pasted image <date> at <time>` instead of pasting text, that the typed draft and the caret are untouched, and that pasting the same screenshot twice reports one skipped duplicate. Paste again **without clicking the composer first** — straight after the Canvas opens, and with the transcript focused — and confirm it still attaches, then confirm a paste into an open dialog still pastes as text there. Copy a range of spreadsheet cells and confirm the paste inserts the text with no attachment; copy a file in Finder and confirm it attaches under its own name.
8. Force the first feed ticket or handshake for a Canvas's Chat to fail while the machine remains online and confirm the conversation's error appears as soon as the feed enters reconnecting, alongside **Try again**. Repeat while offline. Confirm **Try again** can render the conversation while the socket continues its own reconnect loop.
9. Open a Canvas's **Share** as its creator and confirm the three visibilities and the people picker; save a narrower audience and confirm a removed member's Canvas row disappears from their list and they leave the face pile. Open it as a participant who does not manage it and confirm the same audience is read-only.
10. On a Mac, narrow the main window to its 860-pixel minimum, so the navigation collapses into a drawer. Confirm the Canvas header's drawer button, title, and face pile all start to the right of the traffic lights rather than under them, and that the drawer button is clickable. Widen the window again and confirm the header returns to sitting immediately after the navigation, with no gutter of its own. On Windows or Linux, where the buttons are in a frame above the page or not drawn at all, confirm the collapsed header keeps its old 8-pixel gutter and gains no indent.

## Desktop signup, invitations, and settings

Settings search acceptance: in light and dark appearances, search `startup`,
`data residency`, and an exact control label. Enter must reveal the result
without changing its value; Arrow Down/Up navigates results and Escape clears
search (not an IME composition). Search `Tools Rally may use` before installing
MCP and confirm the provider setup card is revealed without authorization.
With two installed servers, search each name and verify the corresponding
instance. Navigate away or focus another field while a read is pending: a late
result must not steal focus. Search Send invitation with a populated
form and verify search does not submit it. These are renderer checks, not proof
of backend authorization; [settings search](settings-search.md) owns the contract.

2. During Google sign-in, confirm the system browser visits `/auth/desktop/`, its address bar is stripped of the fragment, and the **Open Rally** fallback returns the app to the correct regional session. Confirm the renderer never receives a Google code, token, or native PKCE verifier; relaunching the app before ticket redemption must require starting sign-in again.

3. Open an invitation while signed out and confirm its workspace, email, role, and region preview through the issuing regional API. Complete sign-in and accept it once; reuse must fail.

5. Open **Rally → Settings…** and press **Command-,**. Confirm both paths focus the same Settings window and show account/session, the app version under **About**, immutable region, members, and role-appropriate invitation controls. Confirm **Security** sits at the top level between **Organization** and **Connections** and carries the Terminal outbound-access policy, and that **About** lists the version alone — no build, platform, API base URL, or realtime line.

6. The Developer section is served by the `developer-settings` flag, whose
targeting rule matches on the account's **email domain**. Start signed in as a
**non-staff** account and open **Application**: confirm the section is absent
entirely — no heading, no toggle, and no result for a "debug" search of the
settings navigation. That is the only thing scoping it, so it is the case to
check first. Now sign in as a staff account, open **Application**, and confirm
**Developer → Debug enabled** has appeared below Appearance and is off. Turn it
on, then turn the flag off in Flagship with the window still open: within a poll
interval (one minute) confirm the section disappears and the debugging
affordances below are stripped without a restart, and that
`application-settings.json` still records the preference as on. Turn the flag
back on and confirm the section returns with the toggle still checked, then
continue. Right-click a Canvas row, a Sidekick row and a note in the sidebar and confirm no menu offers a copy-id action while the preference is off; turn it on and confirm they gain one without reopening the main window, and that the choice survives a restart. Turn it off and confirm the actions disappear again.

7. Open **Application → Appearance** and confirm the only choices are **System**, **Light**, and **Dark** — there is no Theme family row or palette shelf. Choose Light and confirm the main window uses the `#fcfcfc` conversation canvas, `#f7f7f7` sidebar, dark human bubbles, and a light compact composer. Choose Dark and confirm the canvas becomes `#070707`, the sidebar `#111111`, raised controls `#2f2f2f`, and the selected conversation row `#313131`; the compact composer must remain legible and its voice/send circle must invert. Confirm dropdowns and tooltips invert correctly in both modes. Restart Rally and confirm the chosen appearance is applied before the first frame, with no flash of the other mode. Under System, change the Mac between Light and Dark and confirm every open Rally window follows; after pinning either Light or Dark, changing the Mac must do nothing.

8. Open **Notifications** and confirm **Notify me about** lists exactly Mentions, New messages, Being added, Sidekick runs, Pinned Canvas updates and Access requests, in that order, each with its channels, and no **Daily digest** section. Open the old `digest` settings deep link and confirm it lands on Notifications.

9. Create an invite as an owner/admin and confirm the UI reports **Invitation emailed** only after Resend accepts the request. Verify the message is from `Rally <invites@rallywith.ai>`, contains the correct workspace, role, region, seven-day expiry, and one-time link, then copy the same link from Settings as a fallback.

10. Install a workspace Google Drive connection, open a new Canvas as another active member, and confirm Drive search plus every granted Docs/Sheets read and write tool is offered without attaching a resource. Confirm another member’s personal Google connection remains unavailable and a workspace automation still receives only its explicitly bound capabilities.

11. Open **Connections** with both personal and workspace credentials installed. Confirm they appear in separate **Personal connections** and **Workspace connections** tables, and that either empty table invites you to connect a connector below. Confirm personal owners can refresh their own OAuth connection and members cannot delete workspace credentials. Workspace administrators can open **Manage events** for Ashby, see plain status and the last event, open **Advanced** for technical recovery and **Refresh status** to read saved state, and use the explained **Test** action to attempt supported repair before checking health. Opening the panel must not mutate provider state, and it offers no signing-key rotation guidance to read. Confirm a Granola workspace connection offers no **Manage events** action at all — its page shows status and tools with delete and disconnect only — while its note events keep arriving; changing its Workspace API key means disconnecting and connecting again. Confirm Fireflies offers **Connect for me** and no workspace action at all. Verify Ashby setup asks only for the API key and has no event checkboxes; it explains automatic organization subscriptions. Verify registration status, last delivery, friendly event names, exact-ID reconciliation for an unknown create, API-key replacement, and cleanup recovery; verify management actions are unavailable offline. Confirm refresh and delete each require **Continue** in a dialog before making a request, while **Cancel** leaves the connection untouched; for generic inbound webhook creation or secret replacement, confirm the dialog cannot close before the one-time secret appears. Force deletion to fail and confirm its error is visible inside the dialog. Hover or focus every available **Connect for me** and **Connect for workspace** action, including disabled actions, and confirm the focus target has a name, disabled semantics, and a tooltip explaining that button's personal or workspace scope. Confirm the catalog filter order is **Not connected**, **Connected**, **All**, and that a dual-scope provider remains under **Not connected** when only one installable scope is connected.

12. For each OAuth connector, confirm the provider returns to `/auth/desktop/`, the page reports success or cancellation and offers **Open Rally**, and Settings reaches the same terminal result when automatic app opening is blocked. Close Rally before a successful callback, reopen it, and confirm the persisted connection appears without repeating authorization.

13. Accept the emailed invitation with the matching Google identity, confirm it cannot be reused, then create another invitation and revoke it before opening the email. Confirm the revoked link fails and a non-admin cannot create or revoke invitations. Sign out from Settings and confirm both application surfaces return to onboarding.

### Multiple workspaces

Use two disposable accounts with pre-provisioned configured deployments memberships. Enable
`multiple-workspaces-enabled` except where a step says otherwise.

1. Have account A invite B. While B is already signed in to another workspace,
   open the emailed link, confirm the modal names the workspace, inviter, and
   role, choose **Join**, and confirm B lands in it with both workspaces retained.

3. Leave unsent text and attachments in composers in two workspaces, switch both
   directions, and confirm each restores only its own draft. Leave one workspace
   and confirm only that workspace's draft rows disappear.

5. Copy a Canvas link from A, switch to B, and open it. Confirm Rally
   activates A before navigating and the URL names A's region and workspace UUID.
   Repeat with a random workspace UUID and with a workspace the account has left:
   Rally must remain in B, must not navigate, and must show an access failure
   without exposing the target's name or contents.

6. From a linked Slack installation for A, follow **Create automation**,
   **Manage connections**, a Canvas link, and a freshly minted
   **Connect Rally** challenge while B is active. Each must return to A before
   acting. An ID-only link already in history remains active-workspace-relative
   for compatibility and is never emitted by a current surface.

7. Mention B in a background workspace. Confirm the account trigger gains a dot,
   its row shows a reason-coloured count, the active row shows no duplicate, and
   opening the workspace clears both. With unread activity but nothing addressed,
   confirm the row shows only the ordinary unread dot.

8. Take the device offline after counts have loaded. Confirm the last values stay
   visible with **Counts last updated <relative time>**; selecting a background
   row reads **Connect to open this workspace**, keeps the active surface, and
   discards no credential. Restore connectivity and confirm focus/menu-open
   refreshes recover. The periodic cadence remains unset.

9. Remove B from a background workspace as A. Confirm B's next attention or
   refresh refusal removes that row without a dialog, discovery marks the route
   inactive, and activation cannot reopen it. Repeat while B is active there and
   confirm socket revocation selects the most recent remaining workspace.

10. As the sole owner with other active members, try to leave and confirm Rally
   says another owner must exist. As the only active member of a different
   workspace, choose **Leave and close**, confirm another device's sockets close,
   invitations cannot race acceptance, and signing in again never surfaces it.

11. Start a meeting recording, then try switching, creating, joining, and leaving.
   Each must read **Finish or stop the recording before switching workspaces** and
   leave capture plus the active workspace untouched. End capture and repeat one
   switch successfully. Delay a workspace transition after it starts and try to
   begin recording from the meeting window; confirm recording is refused and the
   transition remains the only pending operation.

12. Sign out online with the account credential and three workspace credentials.
   Confirm every server logout is attempted and the credential, profile, and
   draft stores are empty. Repeat with one regional Worker unreachable: local
   stores still empty, while cleanup reports the failed server revocation.

13. Enable Lockdown with several credentials, restart, and confirm configured deployments
    switching still works from the encrypted set. Disable Lockdown or clear
    credentials and confirm no sibling credential/profile copy remains.

14. Turn `multiple-workspaces-enabled` off with two memberships. Confirm the menu
    shows Settings, one divider, and Log out; the device-local active workspace
    remains usable. Open the account with an older desktop build and confirm the
    singular compatibility workspace opens instead of onboarding failing.

15. Open an invitation addressed to another email while signed in. Confirm the
    modal names the exact required address, signing in with the current account
    cannot consume it, and changing to the matching account can accept it.

16. Seed a version-1 workspace-only credential envelope, launch Rally, and complete
    one Google exchange. Confirm the same regional workspace reconnects in place
    rather than sending the account through setup. With enough workspace and
    invitation rows to exceed the account-menu viewport, confirm its body scrolls
    with Settings, workspace and invitation rows, and the final Log out reachable.
    Confirm exactly one divider immediately precedes Log out and none follows it.

## Regional telemetry acceptance

Use disposable configured deployments accounts plus a private test PostHog project. Never
use a customer dump for this acceptance run.

1. Start from a fresh profile with product analytics on by default. Confirm
   onboarding has no analytics choice. Complete a few onboarding screens, sign in,
   and create or activate a Global workspace. In PostHog, confirm the anonymous
   epoch's funnel events join automatically to the stable person using `$identify`,
   that the profile has the verified name and email, and that the workspace group
   has its current name. Confirm desktop events carry the random installation ID
   as `$device_id`, the correct `$is_identified` value, app/OS/locale/timezone and
   display context, and a stable `$window_id` plus viewport dimensions for one
   renderer window. Confirm `$device_id` is not used as `$anon_distinct_id` and
   that the anonymous history merge uses only the current login epoch.

2. Exercise workspace creation, Canvas creation and a run, and connector
   setup. Confirm the semantic client request and authoritative API outcome share
   `operation_id`, and desktop events use `$session_id`. Reload and repeat an
   accepted upload; confirm `$insert_id` prevents duplicate counts.
   On a fresh disposable installation, confirm exactly one
   `Application Installed`; on the next release, confirm one
   `Application Updated` with the
   current and previous version/build. A cold `Application Opened` must include
   its current version/build, `from_background=false`, and the closed
   `application_open_source`. Confirm a login-item launch is `system_start`; a
   cold launch with neither login-item evidence nor a deep link is `user_launch`
   rather than a guessed Dock open; clicking the Dock while Rally is running is
   `dock`; an accepted OS deep link is `deep_link`; and raising Rally from its
   status menu is `menu_bar`. Each must produce exactly one canonical
   `Application Opened`, even when Electron also fires `activate`. A later native
   push-notification fixture must prove `push_notification` before that producer
   ships; email, Slack, and browser notification links remain `deep_link` without
   such a native callback. Upgrading a profile created before this
   instrumentation must establish a baseline without emitting
   `Application Installed`.

4. Disable analytics while Crashpad is active. Confirm Settings immediately says
   crash upload stopped and restart is required to remove local dumps. Restart and
   confirm the invalidated generation is purged before a new Crashpad handler can
   start. A failure to write the local preference must leave the toggle disabled
   and must not resume upload.

## Desktop menu bar acceptance

macOS only, and best done from a packaged build — a development run deliberately
never registers a login item. See [`menu-bar.md`](menu-bar.md).

1. Start from an empty profile and confirm the Rally mark is in the menu bar without anyone having asked for it. Switch the system appearance between light and dark, and drag a light and a dark desktop picture behind the menu bar on macOS 26 or 27, confirming the mark stays legible in all four and inverts when the item is highlighted. Confirm it is crisp on a Retina display — a blurred mark means the `@2x` rendition is missing from the bundle.
2. Click it. Confirm the order: a **Needs attention** header with each Sidekick that needs input (sublabel **Needs input**), then Sidekicks and Canvases holding something unread (sublabel **Unread**), five rows in all; then **Recent Canvases**, the five most recently changed Canvases, newest first; then a rule, **Open Rally** and **Quit Rally**. Confirm the menu opens directly on its first header, with no rule above it.
3. Exercise each row from a state where Rally has **no** window open: a Canvas row opens that Canvas, a Sidekick row opens that Sidekick, **Open Rally** opens the main window, and each brings Rally to the front rather than opening behind the frontmost app.
4. Send a message in a Canvas's Chat from a second device and confirm that Canvas moves to the top of **Recent Canvases**, and appears under **Needs attention** as **Unread**, within a few seconds. Have a Sidekick run reach Needs input and confirm its row appears first under **Needs attention**.
5. Name a Canvas with a title past 60 characters. Confirm its row ends at a whole word followed by an ellipsis rather than mid-word, that no dangling comma or hyphen precedes the ellipsis, and that it does not stretch the menu.

6. Open **Settings → Application → Appearance**. Confirm **Show Rally in the menu bar** sits above the app icon and is on. Turn it off and confirm the item disappears immediately; turn it on and confirm it returns; restart and confirm both states survive.
7. Open **System Settings → General → Login Items** and confirm Rally is listed and enabled without anyone having added it. In **Settings → Application → Startup**, confirm **Open Rally at login** is on, turn it off, and confirm Rally disappears from the system list and that a relaunch does **not** re-add it. Turn it back on and confirm the toggle reflects what macOS actually holds — if macOS asks for approval, the toggle must stay off until it is given. Remove the login item from System Settings while Rally runs, reopen Settings, and confirm the toggle reads off.
8. With the login item enabled, restart the Mac. Confirm Rally comes back with the menu bar item present and **no window on screen**, that the menu's recent list is already populated, and that **Open Rally** or clicking the Dock icon opens the main window. Then quit and launch Rally by hand and confirm the window opens as usual — a manual launch must never be treated as a login launch.
9. Sign out. Confirm the menu is exactly a **Needs attention** header over **Sign in to Rally**, a rule, **Open Rally**, and **Quit Rally**, with no trace of the previous account's Canvas or Sidekick titles. Confirm the menu neither opens nor closes on a separator.
10. With Product analytics enabled in Global, open the menu once, select a recent row, reopen it, and select **Open Rally**. Confirm PostHog receives one `menu_bar_opened` per visible open — carrying `recentCount` up to 5, `attentionCount` equal to the rows Needs attention lists, and no `suggestionCount` — and one `menu_bar_action_selected` per selection with the matching bounded value. Confirm `open_rally` is **accepted**, not refused: an `open_avalon`-era build's value is admitted too, but a current build must emit `open_rally` and it must land. Confirm no `suggested_work` or `new_meeting_note` value is ever emitted from this surface, and that no semantic event property contains a Canvas or Sidekick title; their UUIDs may appear only in their declared resource/correlation fields.
11. Hold Command and press Command+1–9: no number hints, navigation, or shortcut telemetry should occur. Retained event schemas support older clients only.
12. With Product analytics enabled in Global, launch once and confirm `application_settings_state_v2` contains the actual availability and enabled state for launch-at-login, Lockdown mode, and the menu bar plus the active closed icon identifier and automatic state. Toggle launch-at-login off and on; confirm each `application_setting_change_completed_v2` preserves previous, requested, and macOS read-back applied state, including `requestedEnabled=true` with `appliedEnabled=false` if approval remains pending. Toggle Lockdown mode and menu-bar visibility and confirm the same event uses the matching closed setting only after the native or migration operation succeeds. Select **Ruby**, then **Use the system icon**, and confirm `application_icon_changed` records the previous/applied identifier and automatic state only after each native operation succeeds. Confirm the identified PostHog person has matching `rally_launch_at_login_*`, `rally_lockdown_mode_*`, `rally_application_icon_*`, and `rally_menu_bar_*` current properties. Force each operation to fail and confirm no completion event is emitted; opt out and confirm neither snapshots, changes, nor person-property updates are sent.

## Realtime recovery acceptance

1. Sign in and navigate among several screens. Confirm Electron opens exactly one WorkspaceDO socket for the active workspace and does not reconnect it merely because the open Canvas changed. Confirm the Canvases and Sidekicks lists arrive on the subscribe answer, with no REST list request. From a second client, change workspace timezone, Terminal policy, an invitation/member, and a connector health state; confirm the first client refreshes the corresponding screen within one event without polling or reloading.
2. Disconnect the WorkspaceDO socket after waterline 4, publish several different workspace topics, and reconnect. Confirm it subscribes with `afterWaterline: 4` and receives one newest-waterline event containing the union of missed topics rather than every intermediate invalidation. Exceed the 1,024-event window and confirm one `history_unavailable` event invalidates all workspace surfaces. Send an equal/older waterline afterward and confirm the renderer ignores it. Drop the socket after a user command commits but before its private receipt and confirm reconnect resends the same client message ID and creates exactly one transcript row.
3. Open a Canvas and confirm Electron opens one AgentLoopDO feed socket for its Chat and no other socket for it. From another client, retitle it, post in it, and change its audience; confirm the header and the Canvases list converge from `workspace_canvas_list` pushes at increasing waterlines, and that a duplicated or older push causes no visual reset.
4. Switch between two Canvases whose Chats are streaming. Confirm the feed socket follows the Canvas on screen, the one you return to resumes from its cursor, and neither receives the other's tokens, while the one workspace socket remains. Remove yourself from a Canvas's audience from another client and confirm its row leaves your list and you leave its face pile.
5. Open a Canvas and confirm the first AgentLoopDO frame is `subscribe` with `afterSequence: 0`, followed by one room snapshot rather than duplicate snapshots.
6. Disconnect after receiving an event and reconnect. Confirm the new socket subscribes with the last applied sequence and receives only newer buffered events.
7. Evict/restart the room or exceed its replay window during an active response. Confirm the room sends a canonical snapshot on the same admitted socket, that the snapshot uses the newest transcript page rather than the reader's older unread window, and that the accumulated active stream plus subsequent frames continue without a gap or duplicate. Then force snapshot assembly to fail or overflow the catch-up replay window: confirm `resync_required` with reason `history_unavailable` retains the old socket cursor until HTTP reconciliation succeeds. Separately subscribe with a cursor ahead of the room and confirm `sequence_ahead` takes the same explicit fallback without trusting active output from the lower-sequence room.
8. Start a response before a second client has ever opened that Canvas. Subscribe that client with `afterSequence: 0` and confirm the room snapshot carries the accumulated active text and Bind cursor; publish a frame while the snapshot is loading and confirm catch-up plus live delivery produce the exact response once, with no missing or duplicated boundary chunk.
9. Repeat the first-time join in a Canvas's Chat with older transcript history. Confirm the recovered bubble stays after the triggering message when REST history lands rather than jumping near the start. Fail the run before it persists a final assistant message and confirm the next canonical refresh removes the transient bubble.
10. Leave the workspace and AgentLoopDO sockets idle through at least two heartbeat intervals. Confirm the AgentLoopDO feed uses its 45–55-second jitter, the workspace socket its fixed 50-second interval, and exact text `ping` receives `pong` through Cloudflare auto-response without application-level object work.
11. Simulate a missing `pong`, offline/online transitions, and a burst of reconnecting clients. Confirm the desktop closes stale sockets, applies capped jittered backoff, resumes immediately when online, and keeps each socket's independent waterline/cursor.
12. Attempt each role's upgrade without `Origin`, from an unconfigured origin, with an allowed-origin suffix lookalike, and with a ticket for every mismatched workspace or AgentLoopDO audience. Confirm all are rejected; then connect from the exact desktop or development origin with a fresh purpose-specific ticket.
13. Begin a connector OAuth flow and leave the provider window pending for several minutes. Confirm Electron makes one attempt read and no periodic requests. Complete, deny, and fail separate attempts; in each case confirm the `connector_oauth_attempts` WorkspaceDO topic causes one reconciliation read and the result appears. Disconnect before completion, reconnect after it, and confirm the durable topic waterline reconciles the attempt once.

## Local cache acceptance

1. Sign in, open a Canvas with some history and a Sidekick's conversation.
   Quit Rally. Slow the sockets without touching REST: run the Global Worker
   on another port and put a TCP proxy on `8787` that forwards every
   connection at once except a request whose first line is a `/socket/`
   upgrade, which it holds for eight seconds first, under the first opening
   attempt's ten-second deadline. A cold launch with the API entirely down
   stops at the service screen instead, because the session restore and the
   workspace profile are REST gates above the cache. Launch Rally again:
   confirm the Canvases and Sidekicks lists paint their rows rather than
   skeletons, the last route opens, and its transcript, header, and composer
   are on screen at once under a small floating card reading
   `Connecting to <title>…` with `Sending is available once Rally connects`
   beneath it. Type into the composer and confirm the send button is disabled
   and Enter keeps the text where it is.
2. Open the Sidekick's conversation the same way and confirm it paints with
   its own card, and that no list or detail request is made for what painted.
3. Raise the hold past the three opening attempts (about seventy seconds) and
   confirm the card turns into `Rally could not connect to <title>.` with the
   timeout reason and a **Retry**, while the remembered transcript stays
   readable.
4. Drop the hold and press **Retry**. Confirm the card disappears once the
   first snapshot lands, the composer sends, the draft typed under the card is
   still in it, and the transcript shows the live turns without a visible
   collapse or reorder.
5. Remove yourself from one of the cached Canvases' audiences from another
   client while Rally is quit, then launch again. Confirm its row is gone once
   the subscribe answer lands, and that opening it by deep link before then
   ends in the card's failure state rather than a working composer.
6. Sign out. Confirm `rally-local-cache` under the renderer's IndexedDB is
   empty. Sign in to a second workspace, then leave it, and confirm only that
   workspace's rows were removed.

## Desktop dictation acceptance

Configure the regional Worker with an Azure OpenAI realtime deployment backed by `gpt-live-transcribe`, then run the Electron desktop against that Worker.

1. Open a Canvas and confirm the live-update dot appears in the top-right action bar, no longer appears in the composer, and describes each connected, connecting, reconnecting, and unavailable state in its tooltip. With a screen reader, confirm each state transition is announced from the live region.
2. Confirm the microphone control appears immediately after the file button. Hover it and verify the tooltip reads **Click or hold to dictate**. Hovering also fetches a transcription ticket ahead of the press: in the Worker log confirm one `GET /realtime/transcription/socket` on the hover and none on a press that follows within 50 seconds, and one on a press that follows later.
3. Open the adjacent arrow menu, select a non-default audio input, close and reopen the menu, and confirm the selection remains checked and is exposed as the checked radio item to assistive technology. Restart before granting microphone permission and confirm the saved selection is not erased. Confirm the menu contains no recording-mode toggle.
4. Click the microphone, speak, then click it again. On the press an arc starts turning around the microphone glyph at once, in the button's own ink with nothing on the control red, and the full danger fill replaces it the moment capture is running; while you speak a ring around it follows your level and settles when you stop talking. Keep talking past the field's height: it grows to its limit and then scrolls so the newest words stay in view. Confirm the transcript is appended to the draft without sending the message and incoming deltas do not move keyboard focus away from the Stop control. Repeat by holding the microphone for at least 350 ms and releasing it to stop. With DevTools at the Verbose level, confirm each recording printed one `[perf] dictation_start` line carrying the `inputs`, `capture`, `session` and `backlog` phases and the `captureGraphMs`, `socketTicketMs` and `sessionReadyMs` branch timings.
5. Deny microphone access and confirm Rally reports a recoverable permission error. Grant access in macOS System Settings, restart dictation, and confirm it succeeds without granting camera or display-capture permission. Repeat from a Sidekick's composer (`/sidekicks/:id`): dictation must record there on the same app-wide grant and must not ask for camera or display capture.
6. Inspect the renderer and Worker traffic. Confirm the desktop connects only to Rally's short-lived transcription socket, the Worker opens Azure's `intent=transcription` socket, and no Azure endpoint, deployment, or API key reaches the renderer or logs.
7. Reuse a consumed transcription socket URL and confirm it is rejected. Open two active recordings for one user and confirm a third is rejected; after closing one, confirm a fresh ticket can connect.
8. Delay the ticket response and then the provider session acknowledgement. Confirm the microphone shows recording as soon as local capture starts, speak immediately, and Stop before either response arrives. Then delay the microphone instead (a slow Bluetooth input does it) and confirm the Worker sees the socket upgrade while the control is still armed, before capture has started. Release both responses and confirm the initial audio and final partial frame arrive in order before the commit. The backlog must catch up faster than real time in size-compliant batches. Then stall the renderer during an established recording so several seconds of worklet callbacks queue up. Confirm catch-up delivers every sample in order, Stop sends the final audio before its commit, and the recording stays open through the burst.
9. Leave the ticket request unresolved after recording starts, both with and without pressing Stop. Confirm the existing 10-second connection budget ends the attempt with a recoverable error, releases audio inputs, and aborts the ticket request. Release a late ticket and confirm capture does not restart.
10. Stop and immediately restart while the first permission request is still pending (before recording starts). Resolve the older request last and confirm it cannot reopen a microphone, socket, or overwrite the new draft.
11. After Stop, deliver a transcript delta followed by a corrected completion event. Confirm the partial remains visible and Rally waits for the completion before closing. While it waits, edit the draft or activate **Cancel dictation** and confirm the pending finalization ends immediately without overwriting the edit. Switch conversations during recording and confirm the old capture stops instead of writing into the new draft.

## Desktop model-selector acceptance

Nothing in the Canvases and Sidekicks client picks a model at creation: the
pickers that lived on the Thread and Breakout launchers went with
them. What remains is the locked pill on a conversation that has run, and a
Sidekick's own `model_override`.

1. With Application → Developer → **Debug enabled** off, open a Canvas whose Chat has run and confirm its composer shows no model control.
2. Turn Debug enabled on in the Settings window and confirm the control appears without reopening the screen, immediately to the right of the attachment button, disabled: no menu on click or on Enter, skipped by Tab, reported as disabled to assistive technology, and carrying the run's full model id in its accessible name. Confirm it stays legible at its disabled opacity.
3. Make a Chat's run fail before it streams a token — an invalid `OPENROUTER_API_KEY` does it — and confirm the pill reads what the conversation's row holds (`model_override`, or **Default** when none) rather than a model nobody ran.
4. Repeat for a Sidekick with a `model_override` on its row: draft it in its own conversation, apply it, and exercise every trigger (**Run now**, a scheduled run, a run triggered by matching connector activity, and a run started by mail to the Sidekick's address), confirming each run's conversation carries the override and each run uses it. All four go through the one producer, reading the pin from the Sidekick's row through `readRunDefinition`; the point of exercising all four is that a pin has to survive into a trigger that fires days later.

## Durable automation lifecycle acceptance

Use a disposable workspace and inspect both the Sidekicks sidebar section and
the Sidekicks home.

1. Select **New Sidekick**, type without sending, navigate away, and return.
   Confirm there is no draft row or Sidekick ID. Send one prompt, then
   confirm the same screen adopts `/sidekicks/<id>` and one draft row appears.
2. Close and reopen Rally while the architect is researching a connector.
   Confirm the ordered feed, active checkpoint, streaming response, attachments,
   and composer state recover. Open the same draft in another window and confirm
   simultaneous sends admit only one compiler run while preserving the refused
   window's text.
3. Build and accept a weekday 09:00 Pacific timer automation. Confirm review
   names the resolved schedule and delivery, acceptance keeps the same ID, and
   pause/resume does not create missed catch-up runs.
4. Build one external-event automation that matches an exact resource and a
   case-sensitive substring. Confirm the architect stages rules with
   `sidekick_set_evaluator_rules` before submission. Send matching,
   nonmatching, wrong-case, duplicate, and reordered connector events; only the
   matching canonical event creates one occurrence.
5. Run the active Sidekick manually. Confirm its run appears as one collapsed
   row in the shared conversation, once in the paged run list, opens only
   after the Sidekick admits the reader, and survives a retry without creating
   another run.
6. Archive the Sidekick. Confirm its evaluator registrations are withdrawn,
   its schedules stop, its directory row goes to `deleted` and leaves the
   sidebar, and its runs' records survive. Confirm the Global email claim still
   stands (it is a permanent tombstone) and that mail to the address is refused
   rather than routed.
7. In a real Electron window, compare settled, streaming, failed, elicitation,
   attachment, follow, and **Jump to latest** behavior with a Canvas's Chat.
   Confirm Canvas-only controls (Share, the artifact rail) and Sidekick-only
   controls (Edit Sidekick, run rows) do not leak across the two.
8. Stop the regional API, open **Settings**, and confirm `Escape` closes it
   while it still reads **Opening workspace…** and again on the service-setup
   error — the states with nothing on screen to click. With the API back, open
   **Settings**, type an invitation, click off the field, and confirm `Escape`
   does *not* close it: that is the higher listener having stood down for the
   screen's own, and it is the regression to watch for whenever either install
   moves.

Pass evidence: one stable Sidekick ID, one accepted authority, strict event
matching with one occurrence per canonical event, runs shown as rows in the
shared conversation and the run list, recovered draft/wizard state, and no
legacy subscription/run table reads.

## PRD flow 1 — a shared Canvas

Use a test workspace with two members, Adam and Samantha.

1. Sign in as Adam, choose **New Canvas**, and start it from a prompt. Confirm the Canvas opens on its Chat with the prompt as Adam's first message and Rally's reply streaming in.
2. Open **Share**, add Samantha, and confirm she sees the Canvas in her list and can open it, while a third member who is not on it is told it does not exist.
3. Attach a small text or PDF file and confirm the resource appears without exposing storage identifiers or credentials. Ask Rally for a document and confirm it lands in the right rail as the Canvas's artifact.
4. Open the Canvas as Samantha while Adam has it open and confirm each sees the other in the header's face pile, and that viewing adds nobody to the conversation's participants.
5. Reload both clients and confirm the transcript, audience and artifact remain durable while presence disappears when the second client closes.

Pass evidence: one Canvas, two people in its audience, one persisted attachment and one artifact, one completed harness run, and presence that leaves no participant row.

## Ordered transcript and mid-stream-open acceptance

1. Open a conversation whose first unread turn is at least ten conversation
   turns behind the tail. Confirm first paint contains the first-unread turn,
   five conversation turns before and after it, and the latest five turns from
   one snapshot. Confirm **Jump to latest** moves immediately without a network
   wait and scrolling fills only the adjacent middle gap without moving the
   visible anchor.
2. Run a response that emits text, starts two plugin tools in parallel, settles
   one successfully and one with an error in the reverse order, and then emits
   more text. Confirm the DOM order is first text, the two tools in declared
   call order with independent terminal states, then later text. Confirm tokens
   continue painting while the lifecycle burst occurs.
3. Leave and reopen while that run is still streaming. Confirm accumulated text,
   planned/running/settled tool blocks, active thinking when provider evidence
   exists, and response/plugin/tool timers appear from the snapshot. The active
   labels begin at the server elapsed baseline and advance locally; terminal
   labels use the durable duration.
4. Trigger automatic compaction twice in one long-lived conversation. After each
   event, reconnect and confirm the run continues from the newest exact
   generation, both safe compaction status histories remain distinct, and no
   old private summary or system prompt is visible in the participant feed.
5. Inspect provider-boundary test evidence for the run and confirm the
   reconstructed message-array hash equals the Bind array hash at every request.
   Repeat after transcript healing and after each compaction replacement.
6. Verify `workstream_open` click-to-visible-and-usable results against the
   product targets: p50 at or under one second and p90 at or under two seconds.
   Record renderer total duration; server snapshot duration alone is only a
   lower-bound proxy.
7. Create three turns with deliberately nonmonotonic timestamps and repeated
   text, then load the tail range before the middle range. Confirm the rendered
   order follows only `transcript_sequence`, every turn identity appears once,
   and joining the middle coverage does not move the visible anchor.
8. During one response, reconnect after an optimistic human turn, an active
   assistant overlay, and a completed canonical assistant turn have each been
   observed. Confirm reconciliation uses the explicit client/turn/overlay IDs:
   the optimistic turn is replaced once, the overlay remains at its declared
   anchor until its canonical turn arrives, and unrelated equal text is never
   removed. Deliver stale and duplicate revisions in both orders and confirm
   neither can roll back or duplicate the canonical row.
9. Force a range request across an empty sequence interval, a snapshot-ID
   mismatch, a replay-window miss, and a cursor ahead of the room. Confirm empty
   coverage closes the gap, while every fence/waterline mismatch requests a
   canonical resync without retaining unproven rows or advancing the cursor.
10. Produce assistant prose before and after a tool call, request stop while an
    inference is in flight, and separately force the provider to fail after
    partial output is visible. Confirm stop waits for the accepted assistant and
    all tool effects before ending the loop at its safe step boundary. Confirm a
    failed partial stream disappears and leaves one durable error pill in its
    reserved position. Neither path may concatenate prior prose into a run-final
    aggregate, create a second final answer, or retry observable work.

Pass evidence: stable turn/block IDs, explicit covered ranges and known gaps,
no duplicated/reordered/lost turns, tokens, or tool blocks under permuted frame
delivery, reconnect-safe UTC timing,
two exact compaction generations, provider-boundary hash equality, and p50/p90
opening measurements from the visible desktop boundary. The automation wizard
is not part of this flow.

## PRD flow 2 — recurring web automation

Use a stable public topic with authoritative sources, such as a cloud provider's model-release catalog.

1. Create **Check for new model releases every 24 hours** from natural language and review the compiled interval before creation.
2. Confirm the automation requires the `rally:web` plugin and no connector binding.
3. Run it manually. Confirm exactly one run conversation, successful `web_search` and selected `web_fetch` tool events, source-linked output, and a completed gray conversation state.
4. Retry the same manual-run request with its original idempotency key. Confirm the existing run and conversation are returned and no second harness launches.
5. Let the next recurrence become due and confirm it creates the next planned conversation while preserving the following schedule.

Pass evidence: one initial manual run, one scheduled recurrence, authoritative source links, and no duplicate for the manual retry.

## PRD flow 3 — Google activity

Run this only in provider test accounts after enabling the Google APIs listed in `docs/provider-apps.md`, including Picker, and registering the OAuth callback URLs there. Keep an existing grant on the test account while exercising the second preset: the authorization request must send `include_granted_scopes=false`, and neither the consent screen nor the returned token may inherit scopes from that earlier connection.

### Mail + Calendar preset

1. In Settings, choose **Google Mail + Calendar** and confirm the Rally authorization request contains only `gmail.modify`, `calendar.readonly`, and `calendar.events` plus identity scopes. It must not request Drive, Docs, or Sheets scopes.
2. Exercise `google_gmail_search`, `google_gmail_read_thread` or `google_gmail_read_message`, and `google_gmail_create_draft`. Confirm the draft is present in the provider account, the tool event stores a provider operation reference, and the returned content is bounded/redacted. Do not call `google_gmail_send` during a production smoke test.
3. Exercise `google_calendar_list_calendars`, then use an explicit returned calendar ID with `google_calendar_list_events`, `google_calendar_read_event`, `google_calendar_create_event`, and `google_calendar_update_event` against a clearly named disposable event.
4. Establish Gmail and Calendar poll baselines, then create a new test message and modify the test event. Run the owning connector poll and confirm normalized `email.received`/`email.updated` and `calendar.event_changed` activity is persisted and queued before its cursor advances.
5. Bind a personal automation to the connection and confirm one activity creates one authorized conversation with visible tool events. Confirm a Docs or Sheets tool is rejected because this connection does not hold those capabilities.

### Drive + Docs + Sheets preset

1. With the Mail + Calendar grant from the preceding flow still present, choose **Google Drive + Docs + Sheets** and confirm the Rally authorization request contains only `drive.readonly` and `drive.file` plus identity scopes. It must send `include_granted_scopes=false`; the returned token and stored grant must not contain Gmail or Calendar scopes.
2. Exercise `google_drive_search` and `google_drive_get_metadata` against both a Rally-created file and an arbitrary existing file. Confirm `isAppAuthorized`, `canEdit`, and `writableByRally` distinguish per-file write access correctly; also verify one bounded `google_drive_download` or `google_drive_export` result.
3. Exercise the native Docs tools against a Rally-created file: create a document with `google_docs_create_document`, read it with `google_docs_read_document`, append text with `google_docs_append_text`, and replace an exact fixture string with `google_docs_replace_text`. Attempt the same write against an editable existing Doc whose `isAppAuthorized` is false. Confirm Rally shows **Google needs you to allow Rally to edit this file.**, opens the system-browser Picker filtered to that file, and never attempts the mutation before authorization.
4. Complete the Picker flow. Confirm the callback accepts only the requested file, the original connection credentials remain unchanged, the card reads **Authorized**, and the channel receives the normal user-authored message `Document “<name>” was authorized.` exactly once. Confirm that message starts a continuation and the model successfully retries the blocked write.
5. Exercise the native Sheets tools against a Rally-created file: create a spreadsheet with `google_sheets_create_spreadsheet`, inspect it with `google_sheets_read_spreadsheet`, write an explicit A1 range with `google_sheets_update_values`, append rows with `google_sheets_append_values`, and read the result with `google_sheets_read_values`. Repeat the resource-authorization recovery for an editable existing Sheet. A Sheet the Google user cannot edit must retain the ordinary read-only failure and must not show **Allow editing**.
6. Establish the Drive change-token baseline before editing the Doc and Sheet. After both edits, run the connector poll and confirm the same Drive poll emits `docs.document_changed` and `sheets.spreadsheet_changed`, persists/queues them once, and then advances the Drive cursor. No Google webhook or push delivery should be involved.
7. Bind an automation to this connection and confirm Gmail and Calendar tools are rejected because the connection does not hold those capabilities.

Finally, revoke a test provider grant and repeat an affected read. Confirm the connection changes to **Reconnect required**, dependent work stops safely, and no token or raw provider response body appears in the desktop or logs.

Pass evidence: two independently selectable preset connections, exact stored capability sets, bounded native Docs and Sheets operations, Mail/Calendar and Drive cursors, one Drive-derived Doc activity, one Drive-derived Sheet activity, one authorized automation run per tested connection, and a sanitized reconnect state. Sending email is not required for this flow.

## Flow 9 — mail to a retired Thread's address

1. Send to an address a Thread was issued before the Canvases and Sidekicks pivot and confirm the Global webhook acknowledges it as terminal (`email_thread_retired`) and attaches it nowhere.
2. Send to an unknown alias and confirm the webhook is acknowledged without attaching it anywhere. Send HTML containing script-like content to a Sidekick's address and confirm Rally never renders or executes it.

## Flow 10 — inbound Sidekick email

1. Create personal and workspace Sidekicks with an `inbound_email` trigger in both configured deployments and confirm each exposes a permanent four-segment address from the one account-wide namespace.
2. Send one message to each address. Confirm each owning region stores the untrusted email resource, starts exactly one run with the labelled opening message, and that a personal Sidekick refuses a sender who is not its author or the person it runs as.
3. Replay the same Resend email ID while processing and after completion. Confirm an active lease returns a retryable response, an expired lease can be reclaimed, and the completed replay returns the original run without launching again.
4. Pause a Sidekick and confirm mail cannot start a run. Resume it and confirm the exact same address is active again.
5. Confirm a reservation cannot claim another owner's address, even across regions, and that removing an owner leaves a permanent tombstone. Confirm the same local part on a different accepted domain remains a distinct claim.

## PRD flow 5 — future scheduled run

1. Create a Monday calendar Sidekick in a timezone with daylight-saving transitions and confirm its details' **Wakes on** names the next run's local time.
2. Fire the workspace scheduler for that time, including one repeated alarm delivery.
3. Confirm exactly one run and one harness run start, and the run appears as one row in the Sidekick's shared conversation.
4. Complete the run and confirm the next run is scheduled at the correct local Monday time across the next daylight-saving boundary.

Pass evidence: the occurrence key prevents a duplicate run from the repeated alarm, and the next local occurrence is correct.

## Flow 11 — Slack Agent connector

1. Validate `config/provider-apps/slack.json` with Slack CLI 4.4.0 or later and install the development app in two Slack test workspaces.

2. Connect both Slack installations to one Rally workspace. Confirm two `Slack · <team>` workspace connections exist and that neither bot joins any channel on its own. Invite each bot to a public and a private channel and confirm each invitation creates one Rally Space (Organization-wide for the public channel, private for the private one) and posts one line in the room. Reconnect one installation and confirm a reply in an existing bound thread still reaches its Channel. Attempt to connect either Slack team to a different Rally workspace and confirm `slack_workspace_already_connected`.

3. Open each app Home as an unlinked user. Confirm onboarding, privacy/help, and a **Connect Rally** button that carries no link of its own — copying its address must offer nothing. Leave Home open for more than fifteen minutes, then click it: confirm a modal opens with one **Open Rally** handoff, and that the handoff still works, because nothing on the published view expires. Click **Connect Rally** a second time and confirm the earlier modal's link is refused as already used rather than as expired. Mark the installation for reconnect and confirm the click explains the reconnect instead of offering a link that cannot be redeemed. Link one Rally member and confirm Home changes to the line on what Rally does from Slack, **Create Sidekick** and **Notifications**, a **Needs input** section only while a Sidekick waits (with its question), and **Sidekicks** rows whose names open each Sidekick in Rally, with no **Start a task** button or example prompts.

4. Create a public Slack channel and confirm Rally does not join it. Send a new Agent DM and a channel mention, and run `/rally` with a prompt and both shortcuts. Confirm each is answered once in its thread with "Rally no longer starts work from Slack. Start a Canvas in Rally, or set up a Sidekick to work from Slack for you." and that nothing is created in Rally.
4a. Set up a Sidekick whose result is sent to an Agent DM. Run it, reply in the thread its result started, and confirm the reply gets the acknowledgement reaction (`👀`), or the stopped reaction while the Sidekick is paused, and continues the run rather than starting another.
4b. Configure a workspace reaction override on the installation's `config_json`. Confirm a partial override changes only the states it names, and that an override naming a nonexistent emoji falls back to Rally's own default.

4c. Post an automation result containing a heading, an ordered list, a table, and a fenced code block. Confirm all four render as formatted content in the Agent DM with no literal `#` or `**` characters, and that the title is a header above the body rather than a line of it. Compare a streamed reply and a fallback reply carrying the same content and confirm they render identically. Post a result long enough to split and confirm the break lands on a paragraph seam and that a code block spanning the break arrives as two valid blocks rather than one severed one.

5. Mention one linked Rally teammate and one unlinked teammate whose verified email matches exactly one active member across the installed Slack teams. Confirm both receive one bot-authored Agent DM and the unlinked teammate does not gain a `slack_user_links` record. Repeat with no match, matches in two teams, a cross-team result, and a missing `users:read.email` grant; confirm each falls back to the existing mention email, and the additive missing scope does not disable existing Agent features.

6. Invoke both shortcuts and `/rally` without a prompt; confirm the modal opens in under three seconds, a submission is answered with the retired-ingress copy, and malformed/replayed signatures are rejected.

8. In the thread a Sidekick run's Slack message started, reply as (a) a second linked member, (b) a member with no Slack link whose verified email matches an active Rally member, and (c) a member Rally cannot map at all. Confirm every reply reaches the run, framed as evidence from its sender, and that the third is recorded under its Slack actor.

7. Redeliver the same Events API `event_id` and body; confirm it is acknowledged once. Reuse the ID with different bytes and confirm the conflict is recorded. Force the first regional worker attempt to fail and confirm the durable queue retries the same ingress job instead of permanently deduplicating the failed receipt.

9. From an Agent DM and an app mention, ask Rally to find a message, identify a user/channel, read message/channel/thread/file/member context, and cite the returned permalink. Confirm `assistant.search.context` receives the event's `action_token`, public-only channel types, and a maximum of 20 results; confirm the token is absent from model prompts and tool arguments. Start the same search outside Slack with only the workspace connection and confirm it fails with a user-initiated-search explanation. Confirm specific reads still work without an action token when the bot can access the target conversation.

10. Ask Rally to send a message, add a reaction, and create a public channel, a private channel, a DM, and a group DM through the workspace installation. Confirm the normal write execution/receipt policy without a confirmation prompt, bot attribution, stable `client_msg_id` on messages, idempotent `already_reacted` handling, and no duplicate provider mutation after a workflow retry.

11. Add a personal Slack connection and confirm the row carries
`slack.personal.mcp`. Load it from a conversation and compare the exposed names
and input schemas with Slack's current `tools/list` response rather than a
checked-in expected list. Exercise one tool with `readOnlyHint` and one without;
confirm both receive write execution safeguards and a record-before-execute receipt,
because provider annotations never downgrade Rally policy. Confirm another
Rally member cannot load or use the connection.

12. Copy a Canvas's link from its pill menu and confirm it is the canonical
`https://rallywith.ai/app/<region>/<organization>/cv/<canvas>/`. Paste it into
Slack and confirm the unfurl names the Canvas, with an **Open in Rally**
button, and reveals none of its contents. Do the same for a Sidekick's
`/sk/` link. Paste a current link addressed to another Rally workspace and
confirm this installation refuses to unfurl it rather than resolving the ID
against its own workspace. Repeat in a Slack Connect channel and confirm the
same refusal. Rename the Canvas and confirm the posted card keeps the name it
was posted with. Open the link in a browser and confirm it hands off to the
desktop app; open one with a malformed id, and a retired Thread link, and
confirm the page says so instead of offering a dead button. Paste a bare
`rallywithai://` link and confirm no unfurl is expected, since Slack delivers
no event for it.

13. Create “Check my Gmail every morning and send me the stack-ranked top 3 emails in Slack,” select one Slack Agent DM destination, and inspect the stored frozen target. Run it with three, one, and zero qualifying emails. Confirm the complete ranked Slack output and controls, fewer-than-three behavior, and default empty suppression.

14. Revoke Gmail, then Slack. Confirm each run/destination moves to `needs_input`; no alternate account or Slack installation is selected.

15. Expire a rotating Slack credential and start two simultaneous connector operations. Confirm exactly one `oauth.v2.*.access` refresh consumes the old refresh token and both operations continue with the newly persisted token pair.

## Flow 12 — Notion personal MCP and workspace connector

1. As a regular Rally member, open **Connections** and confirm Notion offers **Connect for me**. As an owner or administrator, confirm it also offers **Connect for workspace**; the two actions must remain visibly distinct.
2. Start **Connect for me**. Confirm authorization uses Notion's official hosted MCP flow, then inspect the resulting row: it is personal, owned by the initiating Rally user, grants `notion.personal.mcp`, stores a DCR client and rotating credential, and creates no `notion_workspace_routes` row.
3. From that member's fresh Canvas, load Notion and compare the exposed names, descriptions, and input schemas with the server's current `tools/list` response. Use a current read tool, then a current mutation tool against disposable content. Confirm both receive a durable receipt without a confirmation prompt regardless of provider annotations, and confirm another Rally member cannot load the personal connection.
4. Expire the personal access token and start two simultaneous MCP operations. Confirm the credential lease redeems the rotating refresh token once, persists the returned pair, and both operations continue. Revoke the grant and confirm the connection becomes `needs_reconnect`.
5. As a Rally owner or administrator, start **Connect for workspace**, approve it as a Notion user, and select a disposable page plus one data source in the page picker. Confirm the resulting row is workspace-scoped with no owner user even though its encrypted credential metadata records the approving Notion user and installed bot.
6. From a fresh Canvas started by another Rally member, search for and read the selected page without attaching it first, then add a clearly marked comment and edit disposable content. Confirm Notion attributes both mutations to the Rally integration bot rather than to the OAuth approver. Confirm an unselected page remains inaccessible.
7. Change the selected page in Notion and confirm the signed webhook becomes one normalized workspace activity with no target user. It must be visible to the workspace opportunity pipeline rather than partitioned to the approver.
8. Bind the workspace connection explicitly to a workspace automation and confirm its fixed Notion API tools work. Confirm an automation without that binding does not acquire the connection merely because Canvass do.

Pass evidence: one owner-only personal MCP connection whose tools match the
live server, one admin-authorized workspace bot connection, member isolation,
serialized rotating refresh, bot-attributed mutations from a second member's
conversation, one workspace-scoped webhook activity, and explicit automation
binding.

## Flow 13 — Fireflies workspace meetings and personal MCP

Needs a live Fireflies workspace, an account that records meetings, and control
of that account's Webhooks page. None of it is reachable offline.

**Run the read half first, with a key alone** — no workspace, no dashboard, no
webhook:

```bash
FIREFLIES_API_KEY=… pnpm --filter @rally/connectors exec vitest run src/fireflies-live.test.ts
```

It drives the shipped adapter against the live API and skips itself without the
variable, so it costs CI nothing. It exists because the first time it was run it
found two schema faults the whole offline suite agreed were fine: the search
document declared a variable type Fireflies documents and does not have, which
invalidated *every* search, and an inner-nullability mismatch beside it. Anything
it reports is wrong before the steps below are worth attempting. It prints
shapes, codes and counts and never meeting content, so it is safe to paste into
a ticket.

1. As a Rally owner or administrator, open **Connections** and confirm the
   Fireflies card offers **Connect for me** and nothing else: the workspace
   connection is withdrawn, and any connection made before that keeps its row,
   its **Delete** action, and no **Manage events** window. The steps below that
   involve a workspace connection need one that already exists; there is no
   longer a way to make one.
2. From a fresh Canvas started by a different member, ask about a recent meeting. Confirm the agent discovers and loads the Fireflies plugin, searches, and reads the summary before the transcript. Ask for a long meeting's transcript and confirm it pages to `nextOffset: null` and stops. Ask it to share or rename a meeting and confirm it says that must be done in Fireflies.
3. Against the existing connection's webhook in Fireflies, record a short meeting. Confirm the `meeting.summarized` delivery produces exactly one digestible activity whose hydrated content carries the summary, and that the earlier `meeting.transcribed` delivery produces an operational one rather than a second digestible. Subscribe `meeting.bot_joined` as well, record another meeting, and confirm that delivery is rejected and does not appear as activity. **Rally no longer shows the endpoint URL, the signing secret or the installation's state anywhere in the product** — the window that did is gone with the workspace scope — so the evidence here is the activity written and Fireflies' own delivery History; the installation's own fields are read through the engineering MCP or not at all. `connector-installation-fireflies.test.ts` is what covers the state moving from action required to current on a verifying delivery.
4. Give a Sidekick a `connector_activity` trigger on `meeting.summarized` for the connection and confirm the summary activity starts one run. Give one a trigger on `meeting.transcribed` and confirm it fires on the operational event.
5. Revoke the API key in Fireflies and use a Fireflies tool: the connection flips to `needs_reconnect`. There is no repair for it — the **Manage events** window is not offered for Fireflies, and `POST /connections/:id/installation/api-key` refuses a replacement key with `connector_scope_not_connectable` even when called directly — so confirm the only remaining action on its connection page is **Delete**. A workspace connection survives the closed scope until its key changes, and then it is over: that is the decision, not an oversight.
6. As a second member, start **Connect for me** and complete Fireflies' browser sign-in. Confirm their conversations gain Fireflies' live tools and that the first member's `list_plugins`/`search_plugins` does not surface them; a forced `load_plugin` is refused with `capability_not_granted`. Leave it a day and confirm whether the personal connection still works or asks to sign in again — which settles whether Fireflies issues a refresh token without `offline_access`.
7. Post to `/ingest/fireflies/:id` unsigned, mis-signed, oversized, and with a stale in-body timestamp. Each is rejected and writes nothing: no activity and no receipt — observable in the conversation and the activity log, since the installation's last-received time is no longer shown in the product. Replay a valid delivery byte for byte and confirm it ingests at most once.
8. Remove the connection. Confirm it is disabled at once and that a delivery to the retired route is rejected. Rally cannot delete the webhook from Fireflies, so delete it there; confirm no way remains in Rally to connect another workspace key.
9. Unset `FIREFLIES_CONNECTOR_ENABLED` in one region and confirm `fireflies` leaves that region's catalog and tool surface, its existing rows are retained, and the other region is unaffected.
10. Run a fleet maintenance preview that changes the Fireflies destination or event set. Confirm every Fireflies installation is listed as customer action and that nothing is applied at Fireflies.

Pass evidence: one pre-existing workspace connection whose meetings the agent
reads, an installation that admits activity only on a verified delivery, exactly one
digestible activity per summarized meeting, a rejected unsubscribed event, a
revoked key that left **Delete** as the only action, one member-scoped
personal MCP connection, four rejected posts that wrote nothing, and a
maintenance preview that applied nothing.

## Provider and deployment note

Flows 2 and 3 require external services and are release gates for a hosted test workspace, not for an offline local build. Follow the regional deployment checklist in `docs/runbook.md`; production smoke should create a Gmail draft unless an explicit send has been approved.

### Sidebar geometry and resizing

The navigation is one sidebar that never collapses
([`desktop-shell.md`](desktop-shell.md)); there is no ⌘B toggle, compact rail,
or bottom collapse control. Drag its edge and confirm it stops at the minimum
rather than snapping shut, and that the width survives a relaunch. Double-click
the right panel's edge and confirm it resets to its default width. Check both
appearances, long titles, and a short window: the account row must remain
visible while the list scrolls.

Hover a public stream icon and then move onto its globe in both appearances.
The globe stays visible and answers for itself — **Public — everyone in the
workspace can see this conversation.** — while the row's own preview card stays
open off the row's right rather than the two taking turns. The card names the
scope in its own shorter register, **Public to workspace**, rather than
reprinting the tip's sentence a centimetre away. Move on to the status dot below
it and confirm the globe's tip gives way to the dot's, which reads the same
shape.

Then put the pointer away and Tab to that row. Confirm the preview opens on
focus alone and carries **Public to workspace**, because the globe's own tip is
pointer-only by design — it is a badge inside the row's link, and giving it a
tab stop would add one to every public row. Tab to a private row and confirm its
card carries no scope line at all.

Switch applications and come back, which no sandbox can stand in for.

**Establish first that the switch reaches the window at all**, because a guard
that never arms and a guard that works look identical from the outside — both
draw no card. In the renderer's console, `addEventListener` for `blur` and
`focus` on `window`, Command-Tab away and back, and confirm both arrive. If they
do not, nothing below is evidence of anything, and the fix needs the main
process's own `browser-window-blur`/`browser-window-focus` instead; say so
rather than reporting the checks below as passing.

Then: leave the pointer resting over a conversation row, click a different row
first so the window has a focused row to hand back, and Command-Tab away and in.
No preview card and no tooltip may appear — not for the row under the cursor,
and not for the row that holds focus — until the pointer actually moves or a key
goes down. Move the pointer a little without leaving the row and confirm the
card the switch withheld opens then. Repeat with a card already open when you
switch away, and confirm it is gone rather than waiting there on your return.
Repeat once more with a resize handle's drag hint, which is the one tooltip
whose open state its caller holds rather than `Tip`.

Clicking either separator must focus it so ArrowLeft/ArrowRight can
immediately resize it. Public stream links expose their visibility as an
accessible description.
