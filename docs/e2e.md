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
pnpm dev:api
pnpm smoke:local
```

The smoke check signs in through development-only authentication, verifies protected workspace routes, validates the right-rail fixtures and persisted tool transcript, replays a human message without duplicating agent work, receives a realtime snapshot, and rejects reuse of the single-use socket ticket. It does not create provider data or send email.

Set `AVALON_SMOKE_BASE_URL` to exercise another Worker. Local Workers use the development session endpoint; hosted production smoke tests must also set a short-lived `AVALON_SMOKE_ACCESS_TOKEN` because development authentication remains disabled in production.

## Automated behavioral lane

`pnpm e2e:local` drives the running local stack through the same public API the
desktop client uses, in three lanes: **happy** paths that must produce an agent
reply (create-and-reply, follow-up, stop, transcript ordering, title
settlement), **sad** paths that must be refused safely (auth, validation,
idempotent replays, missing targets), and **chaos** paths that must not corrupt
or wedge anything (concurrent bursts). Counts and concurrency are arguments:

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

This lane exists because it catches what the unit and workerd suites
structurally cannot: its first sustained run found a view trigger that crashed
every retried run's settlement, a creation path that never scheduled
work-stream naming, and a compound-SELECT limit under concurrent load.

## Right-sidebar and desktop acceptance

Run the Electron desktop with `pnpm dev:desktop` and exercise these flows against the local Worker:

1. Open **Investigate ENG-142**, open the right sidebar from **Work-stream context**, and confirm participants and current viewers are distinct, then open the resource detail.
2. Turn the resource watch off and on, confirm the state survives a detail refresh, and remove a resource only after the explicit action.
3. Resize the rail through its 320–560 pixel range by dragging the handle standing in the gap outside its leading edge, confirming the handle colors and grows while it is grabbed and that the panel edge does not jump to the pointer when it is grabbed. Confirm there is no expand control. At a narrow window width, confirm the rail overlays the transcript without hiding its close control or the header controls that open it. Then drag the navigation wide and narrow the window to around 1000 pixels so the panel is capped by the room left for it, and confirm the handle stays against the panel's edge rather than floating out into the transcript.
4. Sweep the pointer toward the navigation sidebar's trailing edge and confirm its pill appears once the pointer is within 20 pixels of the edge, at the top of the list and at the bottom alike, and that dragging it resizes the navigation.
5. Open **HyperSight** and confirm it takes the right sidebar, that the inspector closes, and that only the HyperSight control reads as pressed. Confirm the frame stays in place while the two widths animate into each other and the old panel's contents dissolve into the new one's. Reopen **Context** and confirm the reverse. Close the open panel from its own header control and confirm both controls read as unpressed. Resize HyperSight, switch to another work stream and resize its inspector, then return: each panel must reopen at the width it was left at in that work stream, and a work stream that has never opened one starts at 360 pixels.
6. Open **New automation**, verify that required capabilities must each be bound to a healthy connection, and browse workspace templates without exposing the regular work-stream composer.
7. Describe an automation in **New automation** and send one turn without finishing it, then confirm a draft for it appears in the sidebar under Automations — named, marked its own row, and there without anything being created. Confirm every draft sits below the automations that run, carries a dashed open ring instead of a filled state dot, and reads **Draft** in place of a next run. Restart the client, click that draft, and confirm it reopens the builder on the turn it was left at, with the earlier messages above it and the compiler's question still answerable; answer it and confirm no second draft appears. Type an answer without sending it, switch to another draft and back, and confirm the unsent text stayed with the draft it was typed in. Finish one draft, create it, and confirm the same row becomes the automation — its position changes but no draft is left behind beside it. Right-click a draft and confirm **Run now** is disabled and that **Archive draft** appears above **Delete automation**; choose **Archive draft** and confirm the row disappears and does not return after a restart, and that archiving or deleting the draft you are looking at leaves the builder rather than stranding it. Right-click an automation that runs, confirm its menu offers **Delete automation** and no archive action, and that the confirmation dialog names the automation and deletes only after **Delete**. Confirm the deleted automation stops appearing, its next planned run does not open, and mail to its address is rejected while the address stays reserved. Then open an automation and confirm the same action from its overview header's **⋯** menu: it is enabled, reads in the same red as the sidebar's, asks with a dialog naming the automation, and on **Delete** leaves the screen for **New work stream** rather than sitting on an automation that no longer exists. With the network refusing the delete, confirm the dialog stays open and says why instead of closing on a failure.
8. With at least one note in the sidebar, right-click it and confirm the menu offers a visibility action naming the state the note would move to — **Make public to workspace** on a private note, **Make private** on a public one — above **Archive note**, which is in the same red as the other destructive items. Choose the visibility action and confirm the row's private-note badge appears or disappears immediately, that the note's own screen agrees, and that making a public note private still posts the privacy notice into the work streams that lose it. Then choose **Archive note** and confirm it asks first, naming the note and saying it cannot be brought back, that **Cancel** leaves the row alone, and that confirming makes the row disappear, leaves an open note screen behind, and keeps neither the row nor the note as an attachable resource after a restart, while its transcript survives on the server. Right-click a public note another member created and confirm both actions are disabled: only its owner can change or archive it. Start a recording, right-click that note from the main window, and confirm **Archive note** is disabled while the meeting window is capturing — archiving underneath it would fail its next segment save — while the visibility action stays available.
9. Send a human-only acknowledgment and confirm no agent run starts; then submit an actionable request and confirm streaming/tool events appear once despite reconnects. While it streams, scroll up one wheel tick and confirm the viewport stays exactly where you put it for the rest of the turn, that **Jump to latest** appears the moment it stops following, and that pressing it animates back to the newest message rather than cutting. Scroll back to the end by hand and confirm following resumes; scroll up inside a code block or an expanded tool output and confirm that alone does not stop it. Send a message while scrolled up and confirm the transcript returns to the end to show it. Repeat the first check with Page Up rather than the trackpad, having clicked the transcript once to focus it. While its answer is streaming, open another work stream and return: confirm the complete prefix is still present, new chunks continue in the same bubble, and neither text nor the scroll position flashes, duplicates, or jumps. Start a second streaming response without opening its work stream, join it for the first time from another client, and confirm the already-produced text appears once before subsequent chunks continue seamlessly.
10. Mention a workspace member who is not participating and confirm that no participant is added until the person accepts the confirmation prompt.
11. Type `@` mentions in the composer and confirm each workspace member Avalon recognizes is highlighted in the brand color as soon as their full name is typed or picked, while half-typed and unknown handles stay plain — including a connection's name, which the composer no longer offers or recognizes. Confirm the popover walks with `ArrowUp`/`ArrowDown`, wrapping at both ends and scrolling the highlighted row into view, that `Enter` inserts the highlighted person rather than sending, that `Escape` dismisses it, and that the row under the pointer is the one `Enter` takes. Confirm the highlight tracks the caret, wrapping, and scrolling exactly, and that an IME composition still shows its in-flight text. Then run the same checks in **New work stream** and in **New automation**: the `@` control and a typed `@` must open the same list and answer the keyboard the same way in all three, with only the contents differing — workspace members in the two work-stream composers, the workspace's connections in an automation. In **New work stream**, confirm the person taken from the list also joins the avatar row above the composer, and that the **Add people** dialog is still reached from that row.
12. Send that message and confirm the transcript keeps the same brand treatment: the person mention becomes an avatar chip in the brand color, in human and agent messages alike. Confirm the chip does not navigate, and that the connection named in the text stays plain — the composer stores no range for one. On an agent message that does carry a connector mention, confirm the label chip still renders in the same treatment.
13. With a screenshot on the clipboard, paste into the composer of a work stream, of **New work stream**, and of an automation draft. Confirm each paste becomes an uploading attachment tile named `Pasted image <date> at <time>` instead of pasting text, that the typed draft and the caret are untouched, and that pasting the same screenshot twice reports one skipped duplicate. Paste again **without clicking the composer first** — straight after the work stream opens, and with the transcript focused — and confirm it still attaches, then confirm a paste into the resource search field and into an open dialog still pastes as text there. Copy a range of spreadsheet cells and confirm the paste inserts the text with no attachment; copy a file in Finder and confirm it attaches under its own name; copy a passage containing an inline image and confirm the text lands at the caret *and* the image attaches.
14. Force the work-stream detail request to fail — a route such as `#/workstreams/does-not-exist` is enough — and confirm **Work stream could not be opened** offers **Copy work-stream ID** from the top-right menu alongside **Try again**. The copied value is the identifier from the route, which is the only one available once the detail payload has failed.
15. Create a work stream from a long request and watch its name arrive. The sidebar row and the header must show a skeleton in place of a title rather than the request text, and both must fill in with a short name within a second or two, without a reload. Stop the API before the name arrives and confirm the skeleton gives way to the first line of the request within a minute rather than pulsing forever, and that the next message settles the name for real. Reply until the work stream has five messages and confirm the name is chosen once more from the conversation, and only once however many messages follow. Rename it by hand at any point and confirm no later name overwrites yours.
16. Double-click the work-stream name in the header and confirm it becomes an inline editor with the current name selected, a green **Save name** control, and a red **Cancel rename** control, each naming itself on hover. Save a new name and confirm the header and the sidebar row both show it without a reload. Reopen the editor and confirm **Cancel rename** and `Escape` both discard the draft, that a blank name disables Save, and that saving an unchanged name simply closes the editor. Make the rename fail and confirm the editor stays open with the draft intact and the reason in place of the status line. Confirm the name is reachable by keyboard and opens on `Enter` or `F2`, that a single click leaves it alone, and that a rename from the sidebar’s **Rename** menu still works.
17. Right-click an ordinary work-stream row and confirm the menu offers **Make private** below **Rename**, named for the state it moves to the way the note item is. Choose it and confirm the row gains the same lock a private note wears, that the header gains its **Private** badge without a reload, and that the item now reads **Make public to workspace**. As a second member who was reading that work stream in another window, confirm the transcript is replaced by **Work stream could not be opened** rather than sitting there stale, that the sidebar row disappears at the same moment rather than at the next poll, that the client does not keep retrying, and that opening its URL directly is refused. Remove a participant from a private work stream while they have it open and confirm the same thing happens to them. Back in the first window, add that member from the right rail and confirm they can open it, post to it, and add a third member themselves: being in a private work stream is the whole authority, not owning it. Make it public again and confirm the lock and the badge disappear and the second member's sidebar shows it once more. Right-click a work stream an automation generated, and a `Digest · <date> · <time>` occurrence work stream with **Debug enabled** on, and confirm neither menu offers the visibility action at all — both take their audience from something other than this work stream. Make the change fail and confirm a dialog names what did not happen and says the work stream is unchanged.
18. Hover the status dot on a sidebar work-stream row and confirm a tooltip names the state that color stands for — **Needs input**, **Running**, **Scheduled**, **Latest run completed**, or **Needs intervention** — anchored to the right of the dot. Confirm it follows the dot as the status changes, and that the automation rows above are unaffected. As a second member, have somebody add you to a work stream you have never opened and confirm its dot turns violet and reads **New to you** whatever its run is doing, that opening it once settles the dot on the run's own state, and that it never returns to violet however many messages arrive afterwards. In a work stream you have read, have somebody mention you and confirm the dot reads **You were mentioned**; have them post without naming you and confirm it reads **Unread** once the run is no longer working. Confirm the home screen's **Needs attention** section lists exactly those work streams — unseen, mentioned, unread, and waiting for input — newest activity first, and that a running work stream with nothing to answer is not among them.
19. Ask Avalon to follow up at a specific time, then ask it to follow up after a relative delay. Confirm each work-stream row gains a clock at its right edge as soon as the wake-up is pending, including while its latest run is already **Latest run completed**. Hover the clock and confirm its tooltip shows the earliest wake-up's exact local date and time plus no more than 40 characters of its prompt, ending a longer one with an ellipsis. Add a second wake-up, cancel the first, and confirm the tooltip advances to the second; let that one fire and confirm the clock disappears. Work streams with only fired or cancelled wake-ups show no clock.

## Desktop signup, invitations, and settings

1. Start from an empty desktop profile. Enter an organization name and verify the region choices use the descriptions **US-Jurisdiction storage** and **EU-jurisdiction storage**, with no routing or sign-in copy, and that both selectors change the target API. Select European Union and confirm the small secondary notice reads **Unavailable for EU region (at this time, subject to change based on providers)** and includes the bullet **Avalon agent: Terminal access**; select Global again and confirm the notice disappears. Create a development workspace or complete Google sign-in in a provider test account.
2. During Google sign-in, confirm the system browser visits `/auth/desktop/`, its address bar is stripped of the fragment, and the **Open Avalon** fallback returns the app to the correct regional session. Confirm the renderer never receives a Google code, token, or native PKCE verifier; relaunching the app before ticket redemption must require starting sign-in again.
3. Open an invitation while signed out and confirm its organization, email, role, and region preview through the issuing regional API. Complete sign-in and accept it once; reuse must fail.
4. While signed into a Global organization, open an EU invitation. Confirm the current session is not retargeted, the preview still uses the EU API, and the app requires sign-out before continuing with the invited account. Closing the invitation must restore the Global session route.
5. Open **Avalon → Settings…** and press **Command-,**. Confirm both paths focus the same Settings window and show account/session, version/platform/API/realtime diagnostics, immutable region, members, and role-appropriate invitation controls.
6. The Developer section is served by the `developer-settings` flag, whose targeting rule matches on the account's **email domain**. Start signed in as a **non-staff** account and open **Application**: confirm the section is absent entirely — no heading, no toggle, and no result for a "debug" search of the settings navigation. That is the only thing scoping it, so it is the case to check first. Now sign in as a staff account, open **Application**, and confirm **Developer → Debug enabled** has appeared below Appearance and is off. Turn it on, then turn the flag off in Flagship with the window still open: within a poll interval (one minute) confirm the section disappears and the debugging affordances below are stripped without a restart, and that `application-settings.json` still records the preference as on. Turn the flag back on and confirm the section returns with the toggle still checked, then continue. With a digest that has run at least once, confirm its `Digest · <date> · <time>` work stream is absent from the sidebar while the preference is off, appears dimmed, gear-marked, and carrying the same private badge a personal note wears once it is on, reaches full opacity on hover and while active, and disappears again when the preference is turned off. Open it and confirm the header carries a **Private** badge. With two occurrences on the same day, confirm both rows are legible and distinguishable rather than ellipsized to the same text — the time is the only thing telling them apart, and it is at the end of the title. Confirm a second member never sees it in either state, and that opening its URL directly as that member is refused. Right-click a work stream, an automation, and a note in the sidebar and confirm no menu offers a copy action. Open a work stream's right rail and confirm **Details** lists only the work stream's address (if it has one), Created by, Created, and Last activity, with the address on one line. Turn the preference on and confirm all three menus gain **Copy work stream link** / **Copy automation id** / **Copy note id** without reopening the main window, that the automation and note actions copy the resource's identifier while the work-stream one copies its canonical `https://…/app/workstreams/<uuid>` link, that **Details** gains the origin, automation, harness, and identifier rows in the same window, and that the choice survives a restart. Turn it off and confirm all three actions and the extra rows disappear again.
7. Open **Application → Appearance** and confirm the control is two rows: **Appearance** offering System, Light, and Dark, above **Theme** offering Terra and Air. Confirm each swatch is drawn in the theme it offers rather than the running one, that under System every swatch is split on a diagonal showing both of that design's appearances, and that pinning Light or Dark collapses each swatch to the single appearance in force. Confirm the status line beneath names the design and either the appearance the Mac is currently set to or the pinned one. Choose Light and confirm the change is immediate in this window and in the main window, that the Avalon mark beside **Welcome back** stays legible against the page, that a switch reads as off rather than as a gap, and that a dropdown menu and a tooltip both invert correctly. Choose Air and confirm the section headings become letterspaced capitals, the rows and the reading column gain space, the sidebar marks the selected row with a line rather than a filled background, and a field of slowly moving light appears behind the main window. The standalone Settings and meeting windows deliberately stay flat — confirm they do, rather than treating it as a defect. Restart Avalon and confirm the chosen theme is applied before the first frame — no flash of the previous appearance — and that a newly opened Settings or meeting window opens on the right background. **The two axes are independent, and that is the thing to check:** with **Air** and **System** selected, change the Mac between Light and Dark and confirm Avalon crosses between Air's light and dark appearances *without leaving Air*; then pin Dark and confirm changing the Mac does nothing at all. Finally, with the Mac already dark, switch from System to Dark and confirm the main window's Settings picker updates too — the appearance does not change, so a build that compares appearances rather than choices leaves the other window still showing System.
8. Open **Digest**. Confirm it opens off with weekdays selected at 9:00 AM and no timezone picker — the row states your account timezone and links to Account. Press **Weekends**, confirm only Saturday and Sunday stay lit and the preset reads as pressed, then add 12:00 and 16:30 and confirm the chips sort ascending and read as `Noon` and `4:30 PM`. Confirm **Save digest** is inert until something changes, and that an enabled digest with no time or no destination cannot be saved. Turn on **Send me a digest** and **Email**, save, and confirm the next-run line is stated in your account timezone rather than the machine's. Reopen Settings and confirm the schedule came back from the service unchanged. Change your timezone in **Account** and confirm the digest's next run moves to the same wall-clock time in the new zone. With a workspace Slack installation linked to your own Slack identity, confirm a **Slack DM** destination appears in **Deliver to**; with no such link, confirm only Email and the "connect a tool" row are offered.
9. Create an invite as an owner/admin and confirm the UI reports **Invitation emailed** only after Resend accepts the request. Verify the message is from `Avalon <invites@with-avalon.com>`, contains the correct organization, role, region, seven-day expiry, and one-time link, then copy the same link from Settings as a fallback.
10. Install a workspace Google Drive connection, open a fresh work stream as another active member, and confirm Drive search plus every granted Docs/Sheets read and write tool is offered without attaching a resource. Confirm another member’s personal Google connection remains unavailable and a workspace automation still receives only its explicitly bound capabilities.
11. For each OAuth connector, confirm the provider returns to `/auth/desktop/`, the page reports success or cancellation and offers **Open Avalon**, and Settings reaches the same terminal result when automatic app opening is blocked. Close Avalon before a successful callback, reopen it, and confirm the persisted connection appears without repeating authorization.
12. Accept the emailed invitation with the matching Google identity, confirm it cannot be reused, then create another invitation and revoke it before opening the email. Confirm the revoked link fails and a non-admin cannot create or revoke invitations. Sign out from Settings and confirm both application surfaces return to onboarding.

## Regional telemetry acceptance

Use disposable Global and EU accounts plus a private test PostHog project. Never
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
2. Exercise workspace creation, work-stream creation and a run, and connector
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
   rather than a guessed Dock open; clicking the Dock while Avalon is running is
   `dock`; an accepted OS deep link is `deep_link`; and raising Avalon from its
   status menu is `menu_bar`. Each must produce exactly one canonical
   `Application Opened`, even when Electron also fires `activate`. A later native
   push-notification fixture must prove `push_notification` before that producer
   ships; email, Slack, and browser notification links remain `deep_link` without
   such a native callback. Upgrading a profile created before this
   instrumentation must establish a baseline without emitting
   `Application Installed`.
3. Open **Settings → Application → Privacy & diagnostics**. Confirm **Product
   analytics** is on and its disclosure says Global may include verified name and
   email, EU stays in Avalon's EU platform, and essential content-free reliability
   continues when off. Turn it off while offline, exercise product actions, and
   restart before reconnecting. Confirm no product event, detailed JavaScript
   exception, profile update, or native dump from that interval is delivered;
   essential lifecycle/reliability may still be accepted. Turn it back on and
   confirm collection starts only after the regional preference write succeeds.
4. Disable analytics while Crashpad is active. Confirm Settings immediately says
   crash upload stopped and restart is required to remove local dumps. Restart and
   confirm the invalidated generation is purged before a new Crashpad handler can
   start. A failure to write the local preference must leave the toggle disabled
   and must not resume upload.
5. With the staff-only Developer section enabled, open **Telemetry inspector**.
   Generate accepted, sampled, disabled, and schema-rejected decisions. Confirm it
   displays only contract decisions and fixed reason codes: no property values,
   event/person/workspace identifiers, paths, URLs, email, names, or stack text.
   Turn the developer flag off and confirm the inspector disappears without
   changing telemetry policy.
6. For a fresh pre-workspace session, test Cloudflare country inputs at the
   bootstrap boundary. An affirmative EU country must route the anonymous epoch
   immediately to EU and create no native crash generation. A non-EU, absent,
   malformed, failed, or timed-out country signal must route immediately to
   Global. Confirm neither IP nor country is retained and no pending holding row
   exists. Select a different workspace region later and confirm prior events do
   not move or relabel.
7. Repeat the semantic flow in an explicit EU workspace. Confirm the events are
   queryable from the EU internal projection with release/platform/channel and
   operation/session correlation, but no event, profile, exception, dump, or
   aggregate appears in PostHog or Analytics Engine. Confirm the raw dump,
   artifacts, and processor remain in the EU-jurisdiction telemetry bucket and
   EU-pinned compute.
8. Run `pnpm --filter @avalon/desktop test:crashpad` on the supported macOS-arm64
   release host. It must package the pinned Electron version, produce two real
   renderer Crashpad reports, and prove that the first inactive database survives
   whole-directory rotation before the second handler starts. Then exercise the
   packaged Avalon release separately: confirm its production generation
   controller rotates only on the following launch, authenticates upload to the
   fixed route, and requests the private artifact identity published by the
   release workflow. In Global, confirm PostHog receives the full sanitized structured exception with the same
   `$session_id`, release, build, platform, architecture, process, channel, and
   fingerprint, while raw bytes, absolute paths, memory fragments, and source
   excerpts stay internal. In EU, confirm the occurrence and independently
   expiring fingerprint contribution are internal-only.
9. Configure disposable, different `support` and `security` operator tokens in
   each region. Confirm unauthenticated and wrong-token requests to
   `/internal/telemetry/status` fail, while each regional token sees only its own
   fixed snapshot. Verify support can retrieve one synthetic dump only with
   `customer_support`, security can retrieve it only with `incident_response`, and
   each attempt creates the fixed regional audit row. Confirm only security can
   replay a terminal Global event, and that the EU-only issue/crash-free paths are
   `404` in Global. Remove the disposable tokens after the run.

## Desktop menu bar acceptance

macOS only, and best done from a packaged build — a development run deliberately
never registers a login item. See [`menu-bar.md`](menu-bar.md).

1. Start from an empty profile and confirm the Avalon mark is in the menu bar without anyone having asked for it. Switch the system appearance between light and dark, and drag a light and a dark desktop picture behind the menu bar on macOS 26 or 27, confirming the mark stays legible in all four and inverts when the item is highlighted. Confirm it is crisp on a Retina display — a blurred mark means the `@2x` rendition is missing from the bundle.
2. Click it. Confirm the order: **New Meeting/Note**, **New Work Stream**, **New Automation**, a rule, a **Suggestions** header with one row per current suggestion, a rule, a **Recent** header with up to five recent work streams, a rule, a **Pinned** header with up to five pinned ones, a rule, **Open Avalon**, **Quit Avalon**. Confirm both headers are styled as macOS section headers rather than as ordinary rows, and that neither can be clicked. Dismiss every suggestion and confirm the **Suggestions** header stays over a single disabled **Connect platforms to get daily suggestions on work streams to create** row rather than the section disappearing. With nothing pinned, confirm **Pinned** keeps its header over a single disabled **Pin a work stream to see it here** row. Confirm the recent rows match the top of the sidebar in the same order, that a work stream Avalon is still naming reads **Untitled work stream** rather than a placeholder, and that the menu offers no login-item checkbox.
3. Exercise each row from a state where Avalon has **no** window open: the meeting/note row opens a notes window, the work stream row opens the new-work-stream screen, the automation row opens the new-automation screen, a recent row opens that work stream, and each brings Avalon to the front rather than opening behind the frontmost app. Confirm a suggestion row creates its work stream, opens it, and that the suggestion is gone from the menu on the next open. With a window already open on some other screen, confirm **New Work Stream** navigates it rather than doing nothing.
4. Send a message in another work stream from a second device and confirm that work stream moves to the top of the menu's recent list within a few seconds of the pointer reaching the status item.
5. Pin six work streams from the sidebar and arrange them by hand. Confirm the menu's **Pinned** rows are the first five of that arrangement in the same order, that each opens its work stream, and that a pinned stream appears only under **Pinned** — never also under **Recent**. Reorder the top two in the sidebar and confirm the menu follows within a refresh. Unpin them all and confirm the rows are replaced by **Pin a work stream to see it here** rather than the section disappearing. See [`workstream-pinning.md`](workstream-pinning.md).
6. Start a work stream whose title runs past 60 characters, and find a suggestion that does the same. Confirm both rows end at a whole word followed by an ellipsis rather than mid-word, that no dangling comma or hyphen precedes the ellipsis, and that neither row stretches the menu.
7. Open **Settings → Application → Appearance**. Confirm **Show Avalon in the menu bar** sits above the app icon and is on. Turn it off and confirm the item disappears immediately; turn it on and confirm it returns; restart and confirm both states survive.
8. Open **System Settings → General → Login Items** and confirm Avalon is listed and enabled without anyone having added it. In **Settings → Application → Startup**, confirm **Open Avalon at login** is on, turn it off, and confirm Avalon disappears from the system list and that a relaunch does **not** re-add it. Turn it back on and confirm the toggle reflects what macOS actually holds — if macOS asks for approval, the toggle must stay off until it is given. Remove the login item from System Settings while Avalon runs, reopen Settings, and confirm the toggle reads off.
9. With the login item enabled, restart the Mac. Confirm Avalon comes back with the menu bar item present and **no window on screen**, that the menu's recent list is already populated, and that **Open Avalon** or clicking the Dock icon opens the main window. Then quit and launch Avalon by hand and confirm the window opens as usual — a manual launch must never be treated as a login launch.
10. Sign out. Confirm the menu keeps all three fixed actions, replaces the recent list with a disabled **Sign in to Avalon** row, drops the **Suggestions** and **Pinned** groups entirely, and shows no trace of the previous account's work-stream titles. Signed out the menu is exactly nine rows, and every one of them works.
11. With Product analytics enabled in Global, open the menu once, select **New Work Stream**, reopen it, and successfully start one suggestion. Confirm PostHog receives one `menu_bar_opened` per visible open, the matching bounded `menu_bar_action_selected` values, and one API-originated `suggested_work_started_v2` with `surface=menu_bar` plus bounded exposure context. Make one suggested-work start fail and confirm it emits the selection but no successful-start event. Confirm no semantic event property contains the displayed suggestion or title; opportunity and work-stream UUIDs may appear only in their declared resource/correlation fields.
12. In the sidebar, hold Command through repeated keydown events and confirm exactly one `command_shortcuts_revealed` with the visible target count. Press a valid Command+1–9 shortcut and confirm one `command_shortcut_used` with its number and destination class. Repeat a number key, press an unassigned number, and try behind a modal; confirm none produce a use event. Start suggested work from the home surface and confirm the authoritative API event instead carries `surface=workspace_home`.
13. With Product analytics enabled in Global, launch once and confirm `application_settings_state_v2` contains the actual availability and enabled state for launch-at-login, Lockdown mode, and the menu bar plus the active closed icon identifier and automatic state. Toggle launch-at-login off and on; confirm each `application_setting_change_completed_v2` preserves previous, requested, and macOS read-back applied state, including `requestedEnabled=true` with `appliedEnabled=false` if approval remains pending. Toggle Lockdown mode and menu-bar visibility and confirm the same event uses the matching closed setting only after the native or migration operation succeeds. Select **Ruby**, then **Use the system icon**, and confirm `application_icon_changed` records the previous/applied identifier and automatic state only after each native operation succeeds. Confirm the identified PostHog person has matching `avalon_launch_at_login_*`, `avalon_lockdown_mode_*`, `avalon_application_icon_*`, and `avalon_menu_bar_*` current properties. Force each operation to fail and confirm no completion event is emitted; opt out and confirm neither snapshots, changes, nor person-property updates are sent.

## Realtime recovery acceptance

1. Sign in and navigate among several screens. Confirm Electron opens exactly one WorkspaceDO socket for the active workspace and does not reconnect it merely because the selected work stream changed. Confirm the initial sidebar and each infinite-scroll page are correlated `list_workstreams` / `workspace_workstream_page` messages on that socket, with no REST/D1 work-stream-list request. From a second client, change workspace timezone, Terminal policy, an invitation/member, and a connector health state; confirm the first client refreshes the corresponding screen within one event without polling or reloading.
2. Disconnect the WorkspaceDO socket after waterline 4, publish several different workspace topics, and reconnect. Confirm it subscribes with `afterWaterline: 4` and receives one newest-waterline event containing the union of missed topics rather than every intermediate invalidation. Exceed the 1,024-event window and confirm one `history_unavailable` event invalidates all workspace surfaces. Send an equal/older waterline afterward and confirm the renderer ignores it. Drop the socket after a user command commits but before its private receipt and confirm reconnect resends the same client message ID and creates exactly one transcript row.
3. Open a work stream and confirm Electron also opens one WorkstreamDO metadata socket and one SubstreamAgent feed socket. Rename it, clear its email/plan, change its state and mention/read metadata from another client, and confirm the header, sidebar Active/In Progress/Completed grouping, unread marker, and You Are Mentioned view converge from complete snapshots with independent increasing common/viewer waterlines. Confirm the WorkstreamDO event arrives immediately and the Queue-delayed WorkspaceDO copy carries the same UUIDv7 for each matching common/viewer row; the second copy must cause no visual reset. Close that work stream's two sockets, make another metadata/mention change, and confirm the WorkspaceDO state event/page alone updates the sidebar. Deliver viewer waterline 6 before common waterline 5, then duplicate and reorder both Queue messages; confirm each field advances independently and neither rolls back. Disconnect WorkspaceDO during an older-page request, reconnect it, and confirm the pending request resumes once with no missing, duplicated, or re-ordered rows and that an already-resident directory is refreshed to the latest state. A lower generation/waterline or older WorkspaceDO directory page must not roll back common/viewer fields or pin position.
4. Switch between two streaming work streams. Confirm both running work streams retain their WorkstreamDO and SubstreamAgent sockets, each resumes its own cursor, and neither receives the other's metadata or tokens. Once an unselected work stream is idle, confirm both child-scoped sockets close while the one workspace socket remains. Revoke access to a private work stream and confirm its metadata/detail/sidebar row is removed and its feed stops retrying.
5. Open a work stream and confirm the first SubstreamAgent frame is `subscribe` with `afterSequence: 0`, followed by one room snapshot rather than duplicate snapshots.
6. Disconnect after receiving an event and reconnect. Confirm the new socket subscribes with the last applied sequence and receives only newer buffered events.
7. Evict/restart the room or exceed its replay window during an active response. Confirm it returns `resync_required` with the accumulated active stream, the desktop preserves that partial while refreshing canonical work stream/transcript/list queries, and the first newer chunk continues it without a gap or duplicate.
8. Start a response before a second client has ever opened its work stream. Subscribe that client with `afterSequence: 0` and confirm the room snapshot carries the accumulated active text and Bind cursor; publish a frame while the snapshot is loading and confirm catch-up plus live delivery produce the exact response once, with no missing or duplicated boundary chunk.
9. Repeat the first-time join in a work stream with older transcript history. Confirm the recovered bubble stays after the triggering message when REST history lands rather than jumping near the start. Fail the run before it persists a final assistant message and confirm the next canonical refresh removes the transient bubble.
10. With HyperSight visible, leave the WorkspaceDO, WorkstreamDO, SubstreamAgent, and BlockDashboardAgent sockets idle through at least two heartbeat intervals. Confirm the SubstreamAgent feed uses its 45–55-second jitter, the other three roles use their fixed 50-second interval, and exact text `ping` receives `pong` through Cloudflare auto-response without application-level object work.
11. Simulate a missing `pong`, offline/online transitions, and a burst of reconnecting clients. Confirm the desktop closes stale sockets, applies capped jittered backoff, resumes immediately when online, and keeps each socket's independent waterline/cursor.
12. Attempt each role's upgrade without `Origin`, from an unconfigured origin, with an allowed-origin suffix lookalike, and with a ticket for every mismatched WorkspaceDO, WorkstreamDO, SubstreamAgent, or BlockDashboardAgent audience. Confirm all are rejected; then connect from the exact desktop or development origin with a fresh purpose-specific ticket.
13. Configure two HyperSight blocks, open the panel, append a message to main substream `0`, and confirm WorkstreamDO creates two independent block runs while Electron opens one direct socket to each block agent. Verify partial Markdown remains visible with an explicit per-block connection state. Disconnect one block socket while output is active, evict that block agent, then reconnect and confirm the full durable checkpoint replaces the cached text without a gap, duplicate, or visual reset; disconnecting WorkstreamDO must not stop either block stream. Revoke the session or hide/remove a block and confirm its direct socket closes with policy code 1008 after the explicit sweep (or within the 60-second fallback bound). Queue two fresher refreshes behind an active block and confirm only the newest queued run remains eligible while the middle run settles as `block_dashboard_run_superseded`. Append another user message after the refresh fence and confirm neither in-flight block reads it; the next refresh may include it.
14. Begin a connector OAuth flow and leave the provider window pending for several minutes. Confirm Electron makes one attempt read and no periodic requests. Complete, deny, and fail separate attempts; in each case confirm the `connector_oauth_attempts` WorkspaceDO topic causes one reconciliation read and the result appears. Disconnect before completion, reconnect after it, and confirm the durable topic waterline reconciles the attempt once.

## Desktop dictation acceptance

Configure the regional Worker with an Azure OpenAI realtime deployment backed by `gpt-live-transcribe`, then run the Electron desktop against that Worker.

1. Open a work stream and confirm the live-update dot appears in the top-right action bar, no longer appears in the composer, and describes each connected, connecting, reconnecting, and unavailable state in its tooltip. With a screen reader, confirm each state transition is announced from the live region.
2. Confirm the microphone control appears immediately after the file button. Hover it and verify the tooltip reads **Click or hold to dictate**.
3. Open the adjacent arrow menu, select a non-default audio input, close and reopen the menu, and confirm the selection remains checked and is exposed as the checked radio item to assistive technology. Restart before granting microphone permission and confirm the saved selection is not erased. Confirm the menu contains no recording-mode toggle.
4. Click the microphone, speak, then click it again. Confirm the transcript is appended to the draft without sending the message and incoming deltas do not move keyboard focus away from the Stop control. Repeat by holding the microphone for at least 350 ms and releasing it to stop.
5. Deny microphone access and confirm Avalon reports a recoverable permission error. Grant access in macOS System Settings, restart dictation, and confirm it succeeds without granting camera or display-capture permission.
6. Inspect the renderer and Worker traffic. Confirm the desktop connects only to Avalon's short-lived transcription socket, the Worker opens Azure's `intent=transcription` socket, and no Azure endpoint, deployment, or API key reaches the renderer or logs.
7. Reuse a consumed transcription socket URL and confirm it is rejected. Open two active recordings for one user and confirm a third is rejected; after closing one, confirm a fresh ticket can connect.
9. Stop and immediately restart while the first permission or ticket request is still pending. Resolve the older request last and confirm it cannot reopen a microphone, socket, or overwrite the new draft.
10. After Stop, deliver a transcript delta followed by a corrected completion event. Confirm the partial remains visible and Avalon waits for the completion before closing. While it waits, edit the draft or activate **Cancel dictation** and confirm the pending finalization ends immediately without overwriting the edit. Switch work streams during recording and confirm the old capture stops instead of writing into the new draft.

## Desktop model-selector acceptance

1. With Application → Developer → **Debug enabled** off, open **New work stream**, **New automation**, and an existing work stream, and confirm none of the three composers shows a model control.
2. Turn Debug enabled on in the Settings window and confirm the control appears in both composers, immediately to the right of the microphone's arrow menu, without reopening either screen. It reads **Default**, and its tooltip says that state follows the `agent-model-workstream` flag rather than naming a model.
3. Open the menu and confirm **Default** leads, the nine models are grouped below it under xAI, Google, OpenAI, and DeepSeek, the check sits on **Default**, and the checked entry is exposed as the checked radio item to assistive technology.
4. Without touching the selector, create a work stream. Confirm its `harness_runs.model` is what `agent-model-workstream` serves and `workstreams.model_override` is `NULL`.
5. Choose a different model, confirm the trigger and tooltip both take its name, then create a work stream. Confirm `workstreams.model_override` holds the chosen id, the run's `harness_runs.model` matches it, and the inference ledger records that model with no fallbacks.
6. Point `agent-model-workstream` at a variation other than the Worker-variable default, then confirm an untouched selector still reads **Default** rather than claiming a model — the served variation is not visible to the client and must not be guessed at.
7. Pin explicitly to the first listed model, confirm the trigger changes from **Default** to **Grok 4.3**, and confirm the created work stream carries that id — an explicit pin to the flag's own default must be distinguishable from never having touched the control. Then choose **Default** again and confirm the next work stream is created with no override.
8. Open a work stream that has run and confirm its composer shows the same control in the same place, chevron and all, and that it is disabled: no menu on click or on Enter, skipped by Tab, reported as disabled to assistive technology, and carrying the run's full model id in its accessible name. Confirm it stays legible at its dimmed opacity, and that hovering still raises the tooltip with that same id — the disable stops the menu, not the tooltip. Check it against `harness_runs.model` for that work stream's latest parent run — on a pinned one that is the pinned id, on an unpinned one it is whatever the flag served, which must be named rather than shown as **Default**. Point the flag at a variation serving a model outside `AGENT_MODEL_OVERRIDES`, start a work stream, and confirm the pill names it (shortened past the vendor prefix) rather than falling back to **Default**. Confirm the two work streams make different claims: the pinned one's tooltip says every run uses that model, the unpinned one's says the flag decides each run and a later run may differ. Then move the flag to another variation, send a message to the unpinned work stream, and confirm the pill follows the new run — proving the unpinned wording rather than the pinned one.
9. Pin a work stream and make its run fail before it streams a token — an invalid `OPENROUTER_API_KEY` does it — so `harness_runs.model` settles as `NULL`. Confirm the pill still names the pinned model rather than **Default**: a pinned work stream never consults the flag, so describing it as following one is wrong rather than merely vague.
10. Create a work stream with a model pinned and confirm the pill on the work-stream screen it opens onto already reads that model, without a **Default** frame in between as the screens change hands.
11. Repeat in **New automation**: choose a model and create the automation. Exercise all three run paths — **Run now**, a scheduled run fired by the workspace scheduler, and a run triggered by matching connector activity — and confirm each one's work stream carries the override and each run uses it. Only the first goes through `AutomationService.createRun`; the other two build the work stream themselves. Confirm the drafting conversation above the composer still runs on the automation architect's own flag.

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

Run this only in provider test accounts after enabling the five Google APIs and registering the OAuth callback URLs in `docs/provider-apps.md`. If the OAuth client already has grants for the test account, revoke the old test grant or inspect the authorization request directly; Google's incremental-consent screen may summarize scopes granted during an earlier connection.

### Mail + Calendar preset

1. In Settings, choose **Google Mail + Calendar** and confirm the Avalon authorization request contains only `gmail.modify`, `calendar.readonly`, and `calendar.events` plus identity scopes. It must not request Drive, Docs, or Sheets scopes.
2. Exercise `google_gmail_search`, `google_gmail_read_thread` or `google_gmail_read_message`, and `google_gmail_create_draft`. Confirm the draft is present in the provider account, the tool event stores a provider operation reference, and the returned content is bounded/redacted. Do not call `google_gmail_send` during a production smoke test.
3. Exercise `google_calendar_list_calendars`, then use an explicit returned calendar ID with `google_calendar_list_events`, `google_calendar_read_event`, `google_calendar_create_event`, and `google_calendar_update_event` against a clearly named disposable event.
4. Establish Gmail and Calendar poll baselines, then create a new test message and modify the test event. Run the owning connector poll and confirm normalized `email.received`/`email.updated` and `calendar.event_changed` activity is persisted and queued before its cursor advances.
5. Bind a personal automation to the connection and confirm one activity creates one authorized work stream with visible tool events. Confirm a Docs or Sheets tool is rejected because this connection does not hold those capabilities.

### Drive + Docs + Sheets preset

1. In Settings, choose **Google Drive + Docs + Sheets** and confirm the Avalon authorization request contains only `drive.readonly` and `drive.file` plus identity scopes. It must not request Gmail or Calendar scopes.
2. Exercise `google_drive_search` and `google_drive_get_metadata` against both an Avalon-created file and an arbitrary existing file. Confirm `isAppAuthorized`, `canEdit`, and `writableByAvalon` distinguish per-file write access correctly; also verify one bounded `google_drive_download` or `google_drive_export` result.
3. Exercise the native Docs tools against an Avalon-created file: create a document with `google_docs_create_document`, read it with `google_docs_read_document`, append text with `google_docs_append_text`, and replace an exact fixture string with `google_docs_replace_text`. Confirm an arbitrary existing Doc found only through Drive search is readable but not writable without a separate per-file grant.
4. Exercise the native Sheets tools against an Avalon-created file: create a spreadsheet with `google_sheets_create_spreadsheet`, inspect it with `google_sheets_read_spreadsheet`, write an explicit A1 range with `google_sheets_update_values`, append rows with `google_sheets_append_values`, and read the result with `google_sheets_read_values`. Confirm an arbitrary existing Sheet found only through Drive search is readable but not writable without a separate per-file grant.
5. Establish the Drive change-token baseline before editing the Doc and Sheet. After both edits, run the connector poll and confirm the same Drive poll emits `docs.document_changed` and `sheets.spreadsheet_changed`, persists/queues them once, and then advances the Drive cursor. No Google webhook or push delivery should be involved.
6. Bind an automation to this connection and confirm Gmail and Calendar tools are rejected because the connection does not hold those capabilities.

Finally, revoke a test provider grant and repeat an affected read. Confirm the connection changes to **Reconnect required**, dependent work stops safely, and no token or raw provider response body appears in the desktop or logs.

Pass evidence: two independently selectable preset connections, exact stored capability sets, bounded native Docs and Sheets operations, Mail/Calendar and Drive cursors, one Drive-derived Doc activity, one Drive-derived Sheet activity, one authorized automation run per tested connection, and a sanitized reconnect state. Sending email is not required for this flow.

## PRD flow 4 — contextual routing (paused)

1. Create a long-lived **CFO of Calm** work stream with at least one participant.
2. Create a signed generic-webhook connection and ingest a transcript activity mentioning Calm and the CFO search.
3. Confirm no Suggested context card appears inside that work stream and no pending `activity_suggestions` row is created.
4. Confirm the unclaimed activity proceeds to suggested-work batching instead of buying the contextual-routing classifier inference.
5. Repeat the same signed delivery identifier and confirm ingestion reports a duplicate without creating a second activity or work opportunity source.

Pass evidence: one activity, no work-stream suggestion or attachment, one batched suggested-work source, stable participant membership, and idempotent webhook replay.

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
3. Open each app Home as an unlinked user. Confirm onboarding, privacy/help, and a **Connect Avalon** button that carries no link of its own — copying its address must offer nothing. Leave Home open for more than fifteen minutes, then click it: confirm a modal opens with one **Open Avalon** handoff, and that the handoff still works, because nothing on the published view expires. Click **Connect Avalon** a second time and confirm the earlier modal's link is refused as already used rather than as expired. Mark the installation for reconnect and confirm the click explains the reconnect instead of offering a link that cannot be redeemed. Link one Avalon member and confirm Home changes to quick actions, active tasks, automations, and notifications.
4. Create a public Slack channel and confirm the `channel_created` ingress job makes Avalon join it. Send a new Agent DM, a threaded follow-up, and a channel mention. Confirm Avalon adds `👀` to each exact triggering message before a workstream or model run starts, each root maps to one `slack_agent_sessions` row, follow-ups reuse the workstream, status appears, and completion stops the stream or posts the fallback thread reply. Replay a claimed job after the reaction succeeds and confirm Slack's `already_reacted` response does not duplicate or fail the task.
4a. Watch the reaction through a whole run. Confirm the triggering message carries `👀` and nothing else within a second; that the reaction changes at least once while the run is live and each value comes from the working set; and that when the run ends the message carries exactly one reaction matching its outcome — `✅` completed, `❓` needs input, `⚠` failed, `🛑` stopped. React to the same message yourself with an unrelated emoji and confirm it is still there at the end. Reply again in the same thread and confirm the reaction moves to the new message and the rotation restarts. Force a run to fail after acknowledgement and confirm the outcome reaction still lands, since delivery rather than the rotation applies it.
4b. Configure a workspace reaction override on the installation's `config_json`. Confirm a partial override changes only the states it names; confirm an override naming a nonexistent emoji falls back to Avalon's default for that state, logs the rejected name, and does not fail the run.
4c. Post an automation result containing a heading, an ordered list, a table, and a fenced code block. Confirm all four render as formatted content in the Agent DM with no literal `#` or `**` characters, and that the title is a header above the body rather than a line of it. Compare a streamed reply and a fallback reply carrying the same content and confirm they render identically. Post a result long enough to split and confirm the break lands on a paragraph seam and that a code block spanning the break arrives as two valid blocks rather than one severed one.
5. Mention one linked Avalon teammate and one unlinked teammate whose verified email matches exactly one active member across the installed Slack teams. Confirm both receive one bot-authored Agent DM and the unlinked teammate does not gain a `slack_user_links` record. Repeat with no match, matches in two teams, a cross-team result, and a missing `users:read.email` grant; confirm each falls back to the existing mention email, and the additive missing scope does not disable existing Agent features.
6. Invoke both shortcuts and `/avalon`; confirm the modal opens in under three seconds, submissions create tasks, and malformed/replayed signatures are rejected.
8. Mention Avalon in a **public** channel from a linked member, then reply in the same thread as (a) a second linked member, (b) a member with no Slack link whose verified email matches an active Avalon member, and (c) a member Avalon cannot map at all. Confirm every reply is taken — none is refused — that the first two are recorded under their own Avalon identities and the third under its Slack actor, and that the work stream is `public` in Avalon. Repeat the whole case in a **private** channel: confirm the work stream is `private`, that it opens already holding the channel's mappable members, that a member who was not in it when it started is seated by their first reply, and that a member of the workspace who is *not* in the Slack channel cannot open it in Avalon.
7. Redeliver the same Events API `event_id` and body; confirm it is acknowledged once. Reuse the ID with different bytes and confirm the conflict is recorded. Force the first regional worker attempt to fail and confirm the durable queue retries the same ingress job instead of permanently deduplicating the failed receipt.
9. From an Agent DM and an app mention, ask Avalon to find a message, identify a user/channel, read message/channel/thread/file/member context, and cite the returned permalink. Confirm `assistant.search.context` receives the event's `action_token`, public-only channel types, and a maximum of 20 results; confirm the token is absent from model prompts and tool arguments. Start the same search outside Slack with only the workspace connection and confirm it fails with a user-initiated-search explanation. Confirm specific reads still work without an action token when the bot can access the target conversation.
10. Ask Avalon to send a message, add a reaction, and create a public channel, a private channel, a DM, and a group DM through the workspace installation. Confirm the normal write confirmation/receipt gate, bot attribution, stable `client_msg_id` on messages, idempotent `already_reacted` handling, and no duplicate provider mutation after a workflow retry.
11. Add a personal Slack connection and confirm the row carries
`slack.personal.mcp`. Load it from a work stream and compare the exposed names
and input schemas with Slack's current `tools/list` response rather than a
checked-in expected list. Exercise one tool with `readOnlyHint` and one without;
confirm both receive write confirmation and a record-before-execute receipt,
because provider annotations never downgrade Avalon policy. Confirm another
Avalon member cannot load or use the connection.
12. Copy a work-stream link from the desktop header and confirm it is the canonical `https://with-avalon.com/app/workstreams/<uuid>`. Paste it into Slack and confirm the unfurl names the work stream — title, last activity, and automation origin where it has one — and reveals no work-stream contents. Confirm a running, needs-input, or failed work stream leads its title with the matching emoji and repeats the word below it, and that a completed one shows no badge at all. Paste a link to a work stream in another Avalon workspace and confirm the anonymous card. Repeat in a Slack Connect channel and confirm the anonymous card there too; confirm both still unfurl rather than being dropped. Then move the work stream from needs-input to completed, wait for the five-minute maintenance sweep, and confirm the posted card rewrites itself in place — losing its badge — without adding a second attachment. Confirm a card whose status has not moved is left alone, and that a move between two unbadged states (completed to idle) also leaves the posted card untouched. Then rename the work stream inline from its header without changing its status, and confirm the posted card picks the new title up on the next five-minute sweep. Change only the objective, which the card never shows, and confirm no second attachment appears and the card is not rewritten. Open the link in a browser and confirm it hands off to the desktop app; open one with a malformed id and confirm the page says so instead of offering a dead button. Paste a legacy `/open#target=avalon://workstreams/<uuid>` link and confirm it still unfurls; paste a bare `avalon://workstreams/<uuid>` and confirm no unfurl is expected, since Slack delivers no event for it.
13. Create “Check my Gmail every morning and send me the stack-ranked top 3 emails in Slack,” select one Slack Agent DM destination, and inspect the stored frozen target. Run it with three, one, and zero qualifying emails. Confirm the complete ranked Slack output and controls, fewer-than-three behavior, and default empty suppression.
14. Revoke Gmail, then Slack. Confirm each run/destination moves to `needs_input`; no alternate account or Slack installation is selected.
14. Repeat an Agent DM and automation delivery for an EU Avalon workspace. Confirm Global stores only the opaque team route, the EU WorkspaceDO owns links/session/delivery state, and the EU work-stream objects own the task and result.
15. Expire a rotating Slack credential and start two simultaneous connector operations. Confirm exactly one `oauth.v2.*.access` refresh consumes the old refresh token and both operations continue with the newly persisted token pair.

## Flow 12 — Notion personal MCP and workspace connector

1. As a regular Avalon member, open **Connections** and confirm Notion offers **Connect for me**. As an owner or administrator, confirm it also offers **Connect workspace**; the two actions must remain visibly distinct.
2. Start **Connect for me**. Confirm authorization uses Notion's official hosted MCP flow, then inspect the resulting row: it is personal, owned by the initiating Avalon user, grants `notion.personal.mcp`, stores a DCR client and rotating credential, and creates no `notion_workspace_routes` row.
3. From that member's fresh ad-hoc work stream, load Notion and compare the exposed names, descriptions, and input schemas with the server's current `tools/list` response. Use a current read tool, then a current mutation tool against disposable content. Confirm both receive confirmation plus a durable receipt regardless of provider annotations, and confirm another Avalon member cannot load the personal connection.
4. Expire the personal access token and start two simultaneous MCP operations. Confirm the credential lease redeems the rotating refresh token once, persists the returned pair, and both operations continue. Revoke the grant and confirm the connection becomes `needs_reconnect`.
5. As an Avalon owner or administrator, start **Connect workspace**, approve it as a Notion user, and select a disposable page plus one data source in the page picker. Confirm the resulting row is workspace-scoped with no owner user even though its encrypted credential metadata records the approving Notion user and installed bot.
6. From a fresh ad-hoc work stream started by another Avalon member, search for and read the selected page without attaching it first, then add a clearly marked comment and edit disposable content. Confirm Notion attributes both mutations to the Avalon integration bot rather than to the OAuth approver. Confirm an unselected page remains inaccessible.
7. Change the selected page in Notion and confirm the signed webhook becomes one normalized workspace activity with no target user. It must be visible to the workspace opportunity pipeline rather than partitioned to the approver.
8. Bind the workspace connection explicitly to a workspace automation and confirm its fixed Notion API tools work. Confirm an automation without that binding does not acquire the connection merely because ad-hoc work streams do.

Pass evidence: one owner-only personal MCP connection whose tools match the
live server, one admin-authorized workspace bot connection, member isolation,
serialized rotating refresh, bot-attributed mutations from a second member's
work stream, one workspace-scoped webhook activity, and explicit automation
binding.

## Provider and deployment note

Flows 2 and 3 require external services and are release gates for a hosted test workspace, not for an offline local build. Follow the regional deployment checklist in `docs/runbook.md`; production smoke should create a Gmail draft unless an explicit send has been approved.
