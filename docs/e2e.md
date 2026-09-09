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

The smoke check signs in through development-only authentication, verifies
protected workspace routes, validates the right-rail fixtures and persisted
tool transcript from the canonical boot, replays a human message over the main
SubstreamAgent socket without duplicating agent work, receives its private
command receipt, and rejects reuse of the single-use socket ticket. It does not
create provider data or send email.

Set `AVALON_SMOKE_BASE_URL` to exercise another Worker. Local Workers use the development session endpoint; hosted production smoke tests must also set a short-lived `AVALON_SMOKE_ACCESS_TOKEN` because development authentication remains disabled in production.

## Automated behavioral lane

`pnpm e2e:local` drives the running local stack through the same REST bootstrap
and SubstreamAgent command socket the desktop client uses, in three lanes:
**happy** paths that must produce an agent
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
Follow-up messages, idempotency replays, validation refusals, concurrent bursts,
and Stop all use the main child's socket; the lane must not preserve deleted
work-stream REST mutation routes as a hidden compatibility client.

## Lightbox and desktop acceptance

The right-sidebar shell host is parked. Resource checks use Manage resources
in the middle sidebar or Resource details from an artifact preview. Test Add
resource, watch, refresh, archive cancellation, and version menus there. Generated
sites must use the isolated native viewer, not file conversion. Route changes
close previews; missing content shows an error without a download action.
Nested dialogs and menus must stay above native content. Retained frame resize
checks belong in an isolated fixture, not a product entry point.

Run the Electron desktop with `pnpm dev:desktop` and exercise these flows against the local Worker:

1. Open **Investigate ENG-142**, choose **Manage resources** in the middle sidebar, and open a resource. Participant and viewer checks use the middle sidebar’s **Manage participants** control.
2. Turn the resource watch off and on, confirm the state survives a detail refresh, and archive a resource only after **Continue** on the confirm modal — the dialog stays until the unlink succeeds, and a refused request leaves the document open with the reason. Open **Versions** from the header and confirm it is a dropdown over the document rather than a pane that replaces it. Open an image resource and confirm the picture itself is in the lightbox, not an empty last-updated panel.
3. In an isolated retained-frame fixture, drag from a persisted width larger than the viewport cap and confirm the first small gesture immediately moves the edge. Check the 320px preferred width, 280px minimum, and responsive maximum; the handle and frame must agree with both sidebars expanded and collapsed. In the product, stale open state must reserve no space, render no right rail, and leave native window size unchanged.
4. Sweep the pointer toward the navigation sidebar's trailing edge and confirm its pill appears once the pointer is within 20 pixels of the edge, at the top of the list and at the bottom alike, and that dragging it resizes the navigation.
5. Open **New automation**, verify that required capabilities must each be bound to a healthy connection, and browse workspace templates without exposing the regular work-stream composer.
6. Describe an automation in **New automation** and send one turn without finishing it, then confirm a draft for it appears in the sidebar under Automations — named, marked its own row, and there without anything being created. Confirm every draft sits below the automations that run, carries a dashed open ring instead of a filled state dot, and reads **Draft** in place of a next run. Restart the client, click that draft, and confirm it reopens the builder on the turn it was left at, with the earlier messages above it and the compiler's question still answerable; answer it and confirm no second draft appears. Type an answer without sending it, switch to another draft and back, and confirm the unsent text stayed with the draft it was typed in. Finish one draft, create it, and confirm the same row becomes the automation — its position changes but no draft is left behind beside it. Right-click a draft and confirm **Run now** is disabled and that **Archive draft** appears above **Delete automation**; choose **Archive draft** and confirm the row disappears and does not return after a restart, and that archiving or deleting the draft you are looking at leaves the builder rather than stranding it. Right-click an automation that runs, confirm its menu offers **Delete automation** and no archive action, and that the confirmation dialog names the automation and deletes only after **Delete**. Confirm the deleted automation stops appearing, its next planned run does not open, and mail to its address is rejected while the address stays reserved. Then open an automation and confirm the same action from its overview header's **⋯** menu: it is enabled, reads in the same red as the sidebar's, asks with a dialog naming the automation, and on **Delete** leaves the screen for the first work stream in the sidebar rather than sitting on an automation that no longer exists. With the network refusing the delete, confirm the dialog stays open and says why instead of closing on a failure.
7. With at least one note in the sidebar, right-click it and confirm the menu offers a visibility action naming the state the note would move to — **Make public to workspace** on a private note, **Make private** on a public one — above **Archive note**, which is in the same red as the other destructive items. Choose the visibility action and confirm the row's private-note badge appears or disappears immediately, that the note's own screen agrees, and that making a public note private still posts the privacy notice into the work streams that lose it. Then choose **Archive note** and confirm it asks first, naming the note and saying it cannot be brought back, that **Cancel** leaves the row alone, and that confirming makes the row disappear, leaves an open note screen behind, and keeps neither the row nor the note as an attachable resource after a restart, while its transcript survives on the server. Right-click a public note another member created and confirm both actions are disabled: only its owner can change or archive it. Start a recording, right-click that note from the main window, and confirm **Archive note** is disabled while the meeting window is capturing — archiving underneath it would fail its next segment save — while the visibility action stays available.
8. Send a human-only acknowledgment and confirm no agent run starts; then submit an actionable request and confirm streaming/tool events appear once despite reconnects. While it streams, scroll up one wheel tick and confirm the viewport stays exactly where you put it for the rest of the turn, that **Jump to latest** appears the moment it stops following, and that pressing it animates back to the newest message rather than cutting — unless the tester has the OS **Reduce Motion** setting on, in which case it must land at the newest message in one instant cut, and creating a work stream must show its opening turn and work timer immediately rather than rising in on a stagger. Scroll back to the end by hand and confirm following resumes; scroll up inside a code block or an expanded tool output and confirm that alone does not stop it. Send a message while scrolled up and confirm the transcript returns to the end to show it. Repeat the first check with Page Up rather than the trackpad, having clicked the transcript once to focus it. While its answer is streaming, open another work stream and return: confirm the complete prefix is still present, new chunks continue in the same bubble, and neither text nor the scroll position flashes, duplicates, or jumps. Start a second streaming response without opening its work stream, join it for the first time from another client, and confirm the already-produced text appears once before subsequent chunks continue seamlessly.
9. Mention a workspace member who is not participating and confirm that no participant is added until the person accepts the confirmation prompt.
10. Type `@` mentions in the composer and confirm each workspace member Rally recognizes is highlighted in the brand color as soon as their full name is typed or picked, while half-typed and unknown handles stay plain — including a connection's name, which the composer no longer offers or recognizes. Confirm the popover walks with `ArrowUp`/`ArrowDown`, wrapping at both ends and scrolling the highlighted row into view, that `Enter` inserts the highlighted person rather than sending, that `Escape` dismisses it, and that the row under the pointer is the one `Enter` takes. Confirm the highlight tracks the caret, wrapping, and scrolling exactly, and that an IME composition still shows its in-flight text. With an IME active, confirm the `Enter` that commits a composition neither sends the message nor runs the slash command on display, in all three composers, and that a second `Enter` does; the same for the `Tab` that would otherwise take the command, and for the `Escape` that abandons a candidate rather than dismissing the list. Then run the same checks in **New work stream** and in **New automation**: the `@` control and a typed `@` must open the same list and answer the keyboard the same way in all three, with only the contents differing — workspace members in the two work-stream composers, the workspace's connections in an automation. In **New work stream**, confirm the person taken from the list also joins the avatar row above the composer, and that the **Add people** dialog is still reached from that row.
11. Send that message and confirm the transcript keeps the same brand treatment: the person mention becomes an avatar chip in the brand color, in human and agent messages alike. Confirm the chip does not navigate, and that the connection named in the text stays plain — neither the composer nor the client's mention resolver produces a range for one. On an agent message that does carry a connector mention, confirm the label chip still renders in the same treatment.
12. With a screenshot on the clipboard, paste into the composer of a work stream, of **New work stream**, and of an automation draft. Confirm each paste becomes an uploading attachment tile named `Pasted image <date> at <time>` instead of pasting text, that the typed draft and the caret are untouched, and that pasting the same screenshot twice reports one skipped duplicate. Paste again **without clicking the composer first** — straight after the work stream opens, and with the transcript focused — and confirm it still attaches, then confirm a paste into the resource search field and into an open dialog still pastes as text there. Copy a range of spreadsheet cells and confirm the paste inserts the text with no attachment; copy a file in Finder and confirm it attaches under its own name; copy a passage containing an inline image and confirm the text lands at the caret *and* the image attaches.
13. Force the first work-stream feed ticket or handshake to fail while the machine remains online and confirm **Work stream could not be opened** appears as soon as the feed enters reconnecting, offering **Copy work-stream ID** from the top-right menu alongside **Try again**. Repeat while offline. Confirm **Try again** invokes the REST recovery boot and can render a valid work stream while the socket continues its own reconnect loop. The copied value is the identifier from the route, which is the only one available before a snapshot arrives.
14. Create a work stream from a long request and watch its name arrive. The sidebar row and the header must show a skeleton in place of a title rather than the request text, and both must fill in with a short name within a second or two, without a reload. Stop the API before the name arrives and confirm the skeleton gives way to the first line of the request within a minute rather than pulsing forever, and that the next message settles the name for real. Reply until the work stream has five messages and confirm the name is chosen once more from the conversation, and only once however many messages follow. Rename it by hand at any point and confirm no later name overwrites yours.
15. Double-click the work-stream name in the header and confirm it becomes an inline editor with the current name selected, a green **Save name** control, and a red **Cancel rename** control, each naming itself on hover. Save a new name and confirm the header and the sidebar row both show it without a reload. Reopen the editor and confirm **Cancel rename** and `Escape` both discard the draft — except while an IME composition is active, where the `Escape` belongs to the IME, abandons its candidate, and leaves the draft and the editor exactly as they were — that a blank name disables Save, and that saving an unchanged name simply closes the editor. Make the rename fail and confirm the editor stays open with the draft intact and the reason in place of the status line. Confirm the name is reachable by keyboard and opens on `Enter` or `F2`, that a single click leaves it alone, and that a rename from the sidebar’s **Rename** menu still works.
16. Right-click an ordinary work-stream row and confirm the menu offers **Make private** below **Rename**, named for the state it moves to the way the note item is. Choose it and confirm the row does not gain the lock a private note wears — a solo personal row has an empty trailing slot rather than your own face — that the Grok-style header stays compact without a **Private** badge, and that the item now reads **Make public to workspace**. As a second member who was reading that work stream in another window, confirm the transcript is replaced by **Work stream could not be opened** rather than sitting there stale, that the sidebar row disappears at the same moment rather than at the next poll, that the client does not keep retrying, and that opening its URL directly is refused. Remove a participant from a private work stream while they have it open and confirm the same thing happens to them. Back in the first window, add that member from the middle sidebar’s participant control and confirm they can open it, post to it, and add a third member themselves: being in a private work stream is the whole authority, not owning it. Confirm the global row has no participant stack; the middle sidebar lists the added participant. Make it public again and confirm the second member's sidebar shows it once more. Right-click a work stream an automation generated, and a `Digest · <date> · <time>` occurrence work stream with **Debug enabled** on, and confirm neither menu offers the visibility action at all — both take their audience from something other than this work stream. Make the change fail and confirm a dialog names what did not happen and says the work stream is unchanged. Confirm the same menu's **Archive work stream**, in the same red as the note and automation items, names the work stream the way they name theirs rather than reading a bare **Archive**, and asks first with a dialog naming it and saying it cannot be brought back. Confirm **Cancel** leaves the row alone, and that confirming makes the row disappear for every member reading it rather than only for the person who archived it. As a second member who has that work stream open while it is archived, confirm the transcript is replaced by **Work stream could not be opened** rather than sitting there stale — the same treatment losing access to a private one gets, and not what the archiver sees, who leaves for the first work stream in the sidebar instead. Archive the work stream you are looking at and confirm the screen leaves for the top sidebar work stream rather than for **New work stream** or a transcript the API no longer serves, and that Back does not return to it. Mark the work stream you are looking at as unread and confirm the same landing, with the marked row keeping its unread state. Archive one whose agent is **Running** and confirm the run stops rather than carrying on out of reach — the transcript of a work stream nobody can reopen is the one place a runaway run would be invisible — and that a work stream with nothing running archives without a stop. Confirm the row does not come back after a restart, and that mail to its address is rejected. Make the archive fail and confirm a dialog names what did not happen and that the row is still there.
17. Hover the status dot on a sidebar work-stream row and confirm a tooltip names the state that color stands for — **Needs input**, **Running**, **Scheduled**, **Unread**, **You were mentioned**, **New to you**, **Latest run stopped**, or **Needs intervention** — anchored to the right of the dot. Confirm it follows the dot as the status changes, and that the automation rows above are unaffected. Confirm a completed, read work stream has no status dot or completion tooltip, while completed work streams with unread, mentioned, or unseen state still show the corresponding personal marker. As a second member, have somebody add you to a work stream you have never opened and confirm its dot turns violet and reads **New to you** whatever its run is doing, that opening and reading it clears the personal marker and either shows the run's state or removes the dot if the run is completed, and that it never returns to violet however many messages arrive afterwards. In a work stream you have read, have somebody mention you and confirm the dot reads **You were mentioned**; have them post without naming you and confirm it reads **Unread** once the run is no longer working. Confirm the home screen's **Needs attention** section lists the work streams that name you — unseen, mentioned, and waiting for input — newest activity first, and that the merely unread one is *not* among them however recently it moved, nor is a running work stream with nothing to answer.
18. Ask Rally to follow up at a specific time, then ask it to follow up after a relative delay. Confirm each work-stream row gains a clock at its right edge as soon as the wake-up is pending, including while its latest run is already **Latest run completed**. Hover the clock and confirm its tooltip shows the earliest wake-up's exact local date and time plus no more than 40 characters of its prompt, ending a longer one with an ellipsis. Add a second wake-up, cancel the first, and confirm the tooltip advances to the second; let that one fire and confirm the clock disappears. Work streams with only fired or cancelled wake-ups show no clock.
19. Populate several recency groups, including more rows in one group than the sidebar has loaded, and confirm every group header has a small **⋯** action. With more than 250 notes in the workspace, scroll the sidebar to the bottom and confirm older notes keep arriving — the list pages the way work streams do — and that a note edited in another window does not snap the list back to its first page. Open it and confirm **Mark all as read** and **Archive all** are the only choices. Choose each in turn and confirm a **Continue** / **Cancel** dialog calls it a mass change and names the complete server-side count rather than only the visible rows. Confirm **Cancel** changes nothing. Continue **Mark all as read** and confirm the dialog named work streams only — a note has no read state — and that every unpinned, non-system work stream in that exact date group loses its unread, mention, and unseen marker while other groups and pinned rows do not. Put notes in the same group first, including one owned by another member and one still recording, and confirm the **Archive all** dialog names work streams *and* notes and counts only the notes you own that are not recording. Confirm an automation's runs are counted by neither dialog: with a recent run and a planned run in that date range, the count matches the rows under the heading, and after **Archive all** the automation's **Recent runs** and **Next run** still open. Continue **Archive all** and confirm the same target set disappears for every member, that your own idle notes under that heading go with it while the other member's note and the recording one stay, that an open target — work stream or note — is replaced by the ordinary unavailable treatment, and that any active run in a target stops. While Queue delivery is in flight, repeat the same operation ID and confirm no work stream is changed twice; change membership before delivery and confirm the removed member's queued personal update is skipped.
20. On a Mac, narrow the main window to its 860-pixel minimum, so the navigation collapses into a drawer. Confirm the work-stream header's drawer button, title, and run status all start to the right of the traffic lights rather than under them, and that the drawer button is clickable — the traffic lights are chrome above the page and take the press, so a header under them is not merely hard to read. Open the resource lightbox at that width and confirm the drawer button keeps its full 30-pixel box while the title truncates around it, rather than the button giving up width first. Widen the window again and confirm the header returns to sitting immediately after the navigation, with no gutter of its own. Do the same on an automation's overview, whose header is laid out by the same rule. On Windows or Linux, where the buttons are in a frame above the page or not drawn at all, confirm the collapsed header keeps its old 8-pixel gutter and gains no indent.

## Desktop signup, invitations, and settings

Settings search acceptance: in light and dark appearances, search `startup`,
`data residency`, and an exact control label. Enter must reveal the result
without changing its value; Arrow Down/Up navigates results and Escape clears
search (not an IME composition). Search `Tools Rally may use` before installing
MCP and confirm the provider setup card is revealed without authorization.
With two installed servers, search each name and verify the corresponding
instance. Navigate away or focus another field while a read is pending: a late
result must not steal focus. Search Send invitation/Save digest with a populated
form and verify search does not submit it. These are renderer checks, not proof
of backend authorization; [settings search](settings-search.md) owns the contract.

1. Start from an empty desktop profile. Enter a workspace name and verify the region choices use the descriptions **US-Jurisdiction storage** and **EU-jurisdiction storage**, with no routing or sign-in copy, and that both selectors change the target API. Select European Union and confirm there is no secondary notice listing unavailable capabilities — Terminal is enabled in both regions. Select Global again and confirm the same. Type the workspace name through an IME and confirm the `Enter` that commits the composition does not create the workspace, while a second `Enter` does. Create a development workspace or complete Google sign-in in a provider test account.
2. During Google sign-in, confirm the system browser visits `/auth/desktop/`, its address bar is stripped of the fragment, and the **Open Rally** fallback returns the app to the correct regional session. Confirm the renderer never receives a Google code, token, or native PKCE verifier; relaunching the app before ticket redemption must require starting sign-in again.
3. Open an invitation while signed out and confirm its workspace, email, role, and region preview through the issuing regional API. Complete sign-in and accept it once; reuse must fail.
4. While signed into a Global workspace, open an EU invitation. Confirm the current session is not retargeted, the preview still uses the EU API, and the app requires sign-out before continuing with the invited account. Closing the invitation must restore the Global session route.
5. Open **Rally → Settings…** and press **Command-,**. Confirm both paths focus the same Settings window and show account/session, version/platform/API/realtime diagnostics, immutable region, members, and role-appropriate invitation controls.
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
continue. With a digest that has run at least once, confirm its
`Digest · <date> · <time>` work stream is absent from the sidebar while the
preference is off, appears dimmed, gear-marked, and with an empty trailing slot
once it is on, reaches full opacity on hover and while active, and disappears
again when the preference is turned off. Open it and confirm the header carries
a **Private** badge. With two occurrences on the same day, confirm both rows are
legible and distinguishable rather than ellipsized to the same text — the time
is the only thing telling them apart, and it is at the end of the title. Confirm
a second member never sees it in either state, and that opening its URL directly
as that member is refused. Right-click a work stream, an automation, and a note
in the sidebar and confirm no menu offers a copy action. Open a work stream's
resource lightbox and confirm **Details** lists only the work stream's address (if it has
one), Created by, Created, and Last activity, with the address on one line. Turn
the preference on and confirm all three menus gain **Copy work stream link** /
**Copy automation id** / **Copy note id** without reopening the main window,
that the automation and note actions copy the resource's identifier while the
work-stream one copies its canonical
`https://rallywith.ai/app/workspaces/<region>/<workspace-uuid>/workstreams/<workstream-uuid>`
link, that **Details** gains the origin, automation, harness, and identifier rows
in the same window, and that the choice survives a restart. Turn it off and
confirm all three actions and the extra rows disappear again.
7. Open **Application → Appearance** and confirm the only choices are **System**, **Light**, and **Dark** — there is no Theme family row or palette shelf. Choose Light and confirm the main window uses the `#fcfcfc` conversation canvas, `#f7f7f7` sidebar, dark human bubbles, and a light compact composer. Choose Dark and confirm the canvas becomes `#070707`, the sidebar `#111111`, raised controls `#2f2f2f`, and the selected work-stream row `#313131`; the compact composer must remain legible and its voice/send circle must invert. Confirm dropdowns and tooltips invert correctly in both modes. Restart Rally and confirm the chosen appearance is applied before the first frame, with no flash of the other mode. Under System, change the Mac between Light and Dark and confirm every open Rally window follows; after pinning either Light or Dark, changing the Mac must do nothing.
8. Open **Digest**. Confirm it opens off with weekdays selected at 9:00 AM and no timezone picker — the row states your account timezone and links to Account. Press **Weekends**, confirm only Saturday and Sunday stay lit and the preset reads as pressed, then add 12:00 and 16:30 and confirm the chips sort ascending and read as `Noon` and `4:30 PM`. Confirm **Save digest** is inert until something changes, and that an enabled digest with no time or no destination cannot be saved. Turn on **Send me a digest** and **Email**, save, and confirm the next-run line is stated in your account timezone rather than the machine's. Reopen Settings and confirm the schedule came back from the service unchanged. Change your timezone in **Account** and confirm the digest's next run moves to the same wall-clock time in the new zone. With a workspace Slack installation linked to your own Slack identity, confirm a **Slack DM** destination appears in **Deliver to**; with no such link, confirm only Email and the "connect a tool" row are offered.
9. Create an invite as an owner/admin and confirm the UI reports **Invitation emailed** only after Resend accepts the request. Verify the message is from `Rally <invites@rallywith.ai>`, contains the correct workspace, role, region, seven-day expiry, and one-time link, then copy the same link from Settings as a fallback.
10. Install a workspace Google Drive connection, open a fresh work stream as another active member, and confirm Drive search plus every granted Docs/Sheets read and write tool is offered without attaching a resource. Confirm another member’s personal Google connection remains unavailable and a workspace automation still receives only its explicitly bound capabilities.
11. Open **Connections** with both personal and workspace credentials installed. Confirm they appear in separate **Personal connections** and **Workspace connections** tables, and that either empty table invites you to connect a connector below. Confirm there are no **Test** actions; an owner or administrator sees a refresh icon with an explanatory tooltip while a member does not, and a member cannot delete a workspace credential. Confirm refresh and delete each require **Continue** in a dialog before making a request, while **Cancel** leaves the connection untouched; while webhook creation or secret replacement is pending, confirm the dialog cannot close before the one-time secret appears. Force deletion to fail and confirm its error is visible inside the dialog. Hover or focus every available **Connect for me** and **Connect workspace** action, including disabled actions, and confirm the focus target has a name, disabled semantics, and a tooltip explaining that button's personal or workspace scope. Confirm the catalog filter order is **Not connected**, **Connected**, **All**, and that a dual-scope provider remains under **Not connected** when only one installable scope is connected.
12. For each OAuth connector, confirm the provider returns to `/auth/desktop/`, the page reports success or cancellation and offers **Open Rally**, and Settings reaches the same terminal result when automatic app opening is blocked. Close Rally before a successful callback, reopen it, and confirm the persisted connection appears without repeating authorization.
13. Accept the emailed invitation with the matching Google identity, confirm it cannot be reused, then create another invitation and revoke it before opening the email. Confirm the revoked link fails and a non-admin cannot create or revoke invitations. Sign out from Settings and confirm both application surfaces return to onboarding.

### Multiple workspaces

Use two disposable accounts with pre-provisioned Global and EU memberships. Enable
`multiple-workspaces-enabled` except where a step says otherwise.

1. Have account A invite B. While B is already signed in to another workspace,
   open the emailed link, confirm the modal names the workspace, inviter, and
   role, choose **Join**, and confirm B lands in it with both workspaces retained.
2. Confirm B's account menu omits About, Help Center, Send Feedback, and Create
   a workspace. Existing members cannot create another workspace from this menu;
   first-workspace creation is covered by onboarding acceptance. Switch
   Global → European Union → Global and confirm sidebar, transcript, Settings,
   meeting window, menu bar, and the singleton workspace socket follow the active
   workspace. Background traffic to the region left must be attention reads only.
3. Leave unsent text and attachments in composers in two workspaces, switch both
   directions, and confirm each restores only its own draft. Leave one workspace
   and confirm only that workspace's draft rows disappear.
4. In same-region workspace A, start each OAuth connector in turn, switch to
   same-region workspace B before accepting provider consent, and complete it.
   Confirm Rally returns to A, the connection appears only in A, and B never
   shows a completion or attempt-confirmation error. Repeat once from EU to
   Global to cover the cross-region session change.
5. Copy a current work-stream link from A, switch to B, and open it. Confirm Rally
   activates A before navigating and the URL names A's region and workspace UUID.
   Repeat with a random workspace UUID and with a workspace the account has left:
   Rally must remain in B, must not navigate, and must show an access failure
   without exposing the target's name or contents.
6. From a linked Slack installation for A, follow **Create automation**,
   **Manage connections**, a result work-stream link, and a freshly minted
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
13. Enable Lockdown with several credentials, restart, and confirm Global and EU
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
   rather than a guessed Dock open; clicking the Dock while Rally is running is
   `dock`; an accepted OS deep link is `deep_link`; and raising Rally from its
   status menu is `menu_bar`. Each must produce exactly one canonical
   `Application Opened`, even when Electron also fires `activate`. A later native
   push-notification fixture must prove `push_notification` before that producer
   ships; email, Slack, and browser notification links remain `deep_link` without
   such a native callback. Upgrading a profile created before this
   instrumentation must establish a baseline without emitting
   `Application Installed`.
3. Open **Settings → Application → Privacy & diagnostics**. Confirm **Product
   analytics** is on and its disclosure says Global may include verified name and
   email, EU stays in Rally's EU platform, and essential content-free reliability
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
8. Run `pnpm --filter @rally/desktop test:crashpad` on the supported macOS-arm64
   release host. It must package the pinned Electron version, produce two real
   renderer Crashpad reports, and prove that the first inactive database survives
   whole-directory rotation before the second handler starts. Then exercise the
   packaged Rally release separately: confirm its production generation
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

1. Start from an empty profile and confirm the Rally mark is in the menu bar without anyone having asked for it. Switch the system appearance between light and dark, and drag a light and a dark desktop picture behind the menu bar on macOS 26 or 27, confirming the mark stays legible in all four and inverts when the item is highlighted. Confirm it is crisp on a Retina display — a blurred mark means the `@2x` rendition is missing from the bundle.
2. Click it. Confirm the order: **New Meeting/Note**, **New Work Stream**, **New Automation**, a rule, a **Suggestions** header with one row per current suggestion, a rule, a **Recent** header with up to five recent work streams, a rule, a **Pinned** header with up to five pinned ones, a rule, **Open Rally**, **Quit Rally**. Confirm both headers are styled as macOS section headers rather than as ordinary rows, and that neither can be clicked. Dismiss every suggestion and confirm the **Suggestions** header stays over a single disabled **Connect platforms to get daily suggestions on work streams to create** row rather than the section disappearing. With nothing pinned, confirm **Pinned** keeps its header over a single disabled **Pin a work stream to see it here** row. Confirm the recent rows match the top of the sidebar in the same order, that a work stream Rally is still naming reads **Untitled work stream** rather than a placeholder, and that the menu offers no login-item checkbox.
3. Exercise each row from a state where Rally has **no** window open: the meeting/note row opens a notes window, the work stream row opens the new-work-stream screen, the automation row opens the new-automation screen, a recent row opens that work stream, and each brings Rally to the front rather than opening behind the frontmost app. Confirm a suggestion row creates its work stream, opens it, and that the suggestion is gone from the menu on the next open. With a window already open on some other screen, confirm **New Work Stream** navigates it rather than doing nothing.
4. Send a message in another work stream from a second device and confirm that work stream moves to the top of the menu's recent list within a few seconds of the pointer reaching the status item.
5. Pin six work streams from the sidebar and arrange them by hand. Confirm the menu's **Pinned** rows are the first five of that arrangement in the same order, that each opens its work stream, and that a pinned stream appears only under **Pinned** — never also under **Recent**. Reorder the top two in the sidebar and confirm the menu follows within a refresh. Unpin them all and confirm the rows are replaced by **Pin a work stream to see it here** rather than the section disappearing. See [`workstream-pinning.md`](workstream-pinning.md).
6. Start a work stream whose title runs past 60 characters, and find a suggestion that does the same. Confirm both rows end at a whole word followed by an ellipsis rather than mid-word, that no dangling comma or hyphen precedes the ellipsis, and that neither row stretches the menu.
7. Open **Settings → Application → Appearance**. Confirm **Show Rally in the menu bar** sits above the app icon and is on. Turn it off and confirm the item disappears immediately; turn it on and confirm it returns; restart and confirm both states survive.
8. Open **System Settings → General → Login Items** and confirm Rally is listed and enabled without anyone having added it. In **Settings → Application → Startup**, confirm **Open Rally at login** is on, turn it off, and confirm Rally disappears from the system list and that a relaunch does **not** re-add it. Turn it back on and confirm the toggle reflects what macOS actually holds — if macOS asks for approval, the toggle must stay off until it is given. Remove the login item from System Settings while Rally runs, reopen Settings, and confirm the toggle reads off.
9. With the login item enabled, restart the Mac. Confirm Rally comes back with the menu bar item present and **no window on screen**, that the menu's recent list is already populated, and that **Open Rally** or clicking the Dock icon opens the main window. Then quit and launch Rally by hand and confirm the window opens as usual — a manual launch must never be treated as a login launch.
10. Sign out. Confirm the menu keeps all three fixed actions, replaces the recent list with a disabled **Sign in to Rally** row, drops the **Suggestions** and **Pinned** groups entirely, and shows no trace of the previous account's work-stream titles. Signed out the menu is exactly nine rows, and every one of them works.
11. With Product analytics enabled in Global, open the menu once, select **New Work Stream**, reopen it, and successfully start one suggestion. Confirm PostHog receives one `menu_bar_opened` per visible open, the matching bounded `menu_bar_action_selected` values, and one API-originated `suggested_work_started_v2` with `surface=menu_bar` plus bounded exposure context. Make one suggested-work start fail and confirm it emits the selection but no successful-start event. Confirm no semantic event property contains the displayed suggestion or title; opportunity and work-stream UUIDs may appear only in their declared resource/correlation fields.
12. Hold Command and press Command+1–9: no number hints, navigation, or shortcut telemetry should occur. Retained event schemas support older clients only.
13. With Product analytics enabled in Global, launch once and confirm `application_settings_state_v2` contains the actual availability and enabled state for launch-at-login, Lockdown mode, and the menu bar plus the active closed icon identifier and automatic state. Toggle launch-at-login off and on; confirm each `application_setting_change_completed_v2` preserves previous, requested, and macOS read-back applied state, including `requestedEnabled=true` with `appliedEnabled=false` if approval remains pending. Toggle Lockdown mode and menu-bar visibility and confirm the same event uses the matching closed setting only after the native or migration operation succeeds. Select **Ruby**, then **Use the system icon**, and confirm `application_icon_changed` records the previous/applied identifier and automatic state only after each native operation succeeds. Confirm the identified PostHog person has matching `rally_launch_at_login_*`, `rally_lockdown_mode_*`, `rally_application_icon_*`, and `rally_menu_bar_*` current properties. Force each operation to fail and confirm no completion event is emitted; opt out and confirm neither snapshots, changes, nor person-property updates are sent.

## Realtime recovery acceptance

1. Sign in and navigate among several screens. Confirm Electron opens exactly one WorkspaceDO socket for the active workspace and does not reconnect it merely because the selected work stream changed. Confirm the initial sidebar and each infinite-scroll page are correlated `list_workstreams` / `workspace_workstream_page` messages on that socket, with no REST/D1 work-stream-list request. From a second client, change workspace timezone, Terminal policy, an invitation/member, and a connector health state; confirm the first client refreshes the corresponding screen within one event without polling or reloading.
2. Disconnect the WorkspaceDO socket after waterline 4, publish several different workspace topics, and reconnect. Confirm it subscribes with `afterWaterline: 4` and receives one newest-waterline event containing the union of missed topics rather than every intermediate invalidation. Exceed the 1,024-event window and confirm one `history_unavailable` event invalidates all workspace surfaces. Send an equal/older waterline afterward and confirm the renderer ignores it. Drop the socket after a user command commits but before its private receipt and confirm reconnect resends the same client message ID and creates exactly one transcript row.
3. Open a work stream and confirm Electron also opens one WorkstreamDO metadata socket and one SubstreamAgent feed socket. Rename it, clear its email/plan, change its state and mention/read metadata from another client, and confirm the header, sidebar Active/In Progress/Completed grouping, unread marker, and You Are Mentioned view converge from complete snapshots with independent increasing common/viewer waterlines. Confirm the WorkstreamDO event arrives immediately and the Queue-delayed WorkspaceDO copy carries the same UUIDv7 for each matching common/viewer row; the second copy must cause no visual reset. Close that work stream's two sockets, make another metadata/mention change, and confirm the WorkspaceDO state event/page alone updates the sidebar. Deliver viewer waterline 6 before common waterline 5, then duplicate and reorder both Queue messages; confirm each field advances independently and neither rolls back. Disconnect WorkspaceDO during an older-page request, reconnect it, and confirm the pending request resumes once with no missing, duplicated, or re-ordered rows and that an already-resident directory is refreshed to the latest state. A lower generation/waterline or older WorkspaceDO directory page must not roll back common/viewer fields or pin position.
4. Switch between two streaming work streams. Confirm both running work streams retain their WorkstreamDO and SubstreamAgent sockets, each resumes its own cursor, and neither receives the other's metadata or tokens. Once an unselected work stream is idle, confirm both child-scoped sockets close while the one workspace socket remains. Revoke access to a private work stream and confirm its metadata/detail/sidebar row is removed and its feed stops retrying.
5. Open a work stream and confirm the first SubstreamAgent frame is `subscribe` with `afterSequence: 0`, followed by one room snapshot rather than duplicate snapshots.
6. Disconnect after receiving an event and reconnect. Confirm the new socket subscribes with the last applied sequence and receives only newer buffered events.
7. Evict/restart the room or exceed its replay window during an active response. Confirm the room sends a canonical snapshot on the same admitted socket, that the snapshot uses the newest transcript page rather than the reader's older unread window, and that the accumulated active stream plus subsequent frames continue without a gap or duplicate. Then force snapshot assembly to fail or overflow the catch-up replay window: confirm `resync_required` with reason `history_unavailable` retains the old socket cursor until HTTP reconciliation succeeds. Separately subscribe with a cursor ahead of the room and confirm `sequence_ahead` takes the same explicit fallback without trusting active output from the lower-sequence room.
8. Start a response before a second client has ever opened its work stream. Subscribe that client with `afterSequence: 0` and confirm the room snapshot carries the accumulated active text and Bind cursor; publish a frame while the snapshot is loading and confirm catch-up plus live delivery produce the exact response once, with no missing or duplicated boundary chunk.
9. Repeat the first-time join in a work stream with older transcript history. Confirm the recovered bubble stays after the triggering message when REST history lands rather than jumping near the start. Fail the run before it persists a final assistant message and confirm the next canonical refresh removes the transient bubble.
10. Leave the WorkspaceDO, WorkstreamDO, and SubstreamAgent sockets idle through at least two heartbeat intervals. Confirm the SubstreamAgent feed uses its 45–55-second jitter, the other two roles use their fixed 50-second interval, and exact text `ping` receives `pong` through Cloudflare auto-response without application-level object work.
11. Simulate a missing `pong`, offline/online transitions, and a burst of reconnecting clients. Confirm the desktop closes stale sockets, applies capped jittered backoff, resumes immediately when online, and keeps each socket's independent waterline/cursor.
12. Attempt each role's upgrade without `Origin`, from an unconfigured origin, with an allowed-origin suffix lookalike, and with a ticket for every mismatched WorkspaceDO, WorkstreamDO, or SubstreamAgent audience. Confirm all are rejected; then connect from the exact desktop or development origin with a fresh purpose-specific ticket.
13. Begin a connector OAuth flow and leave the provider window pending for several minutes. Confirm Electron makes one attempt read and no periodic requests. Complete, deny, and fail separate attempts; in each case confirm the `connector_oauth_attempts` WorkspaceDO topic causes one reconciliation read and the result appears. Disconnect before completion, reconnect after it, and confirm the durable topic waterline reconciles the attempt once.

## Desktop dictation acceptance

Configure the regional Worker with an Azure OpenAI realtime deployment backed by `gpt-live-transcribe`, then run the Electron desktop against that Worker.

1. Open a work stream and confirm the live-update dot appears in the top-right action bar, no longer appears in the composer, and describes each connected, connecting, reconnecting, and unavailable state in its tooltip. With a screen reader, confirm each state transition is announced from the live region.
2. Confirm the microphone control appears immediately after the file button. Hover it and verify the tooltip reads **Click or hold to dictate**.
3. Open the adjacent arrow menu, select a non-default audio input, close and reopen the menu, and confirm the selection remains checked and is exposed as the checked radio item to assistive technology. Restart before granting microphone permission and confirm the saved selection is not erased. Confirm the menu contains no recording-mode toggle.
4. Click the microphone, speak, then click it again. Confirm the transcript is appended to the draft without sending the message and incoming deltas do not move keyboard focus away from the Stop control. Repeat by holding the microphone for at least 350 ms and releasing it to stop.
5. Deny microphone access and confirm Rally reports a recoverable permission error. Grant access in macOS System Settings, restart dictation, and confirm it succeeds without granting camera or display-capture permission.
6. Inspect the renderer and Worker traffic. Confirm the desktop connects only to Rally's short-lived transcription socket, the Worker opens Azure's `intent=transcription` socket, and no Azure endpoint, deployment, or API key reaches the renderer or logs.
7. Reuse a consumed transcription socket URL and confirm it is rejected. Open two active recordings for one user and confirm a third is rejected; after closing one, confirm a fresh ticket can connect.
9. Stop and immediately restart while the first permission or ticket request is still pending. Resolve the older request last and confirm it cannot reopen a microphone, socket, or overwrite the new draft.
10. After Stop, deliver a transcript delta followed by a corrected completion event. Confirm the partial remains visible and Rally waits for the completion before closing. While it waits, edit the draft or activate **Cancel dictation** and confirm the pending finalization ends immediately without overwriting the edit. Switch work streams during recording and confirm the old capture stops instead of writing into the new draft.

## Desktop model-selector acceptance

1. With Application → Developer → **Debug enabled** off, open **New work stream**, **New automation**, and an existing work stream, and confirm none of the three composers shows a model control.
2. Turn Debug enabled on in the Settings window and confirm the control appears in both composers, immediately to the right of the microphone's arrow menu, without reopening either screen. It reads **Default**, and its tooltip says that state follows the `agent-model-workstream` flag rather than naming a model.
3. Open the menu and confirm **Default** leads, every id in `AGENT_MODEL_OVERRIDES` is grouped below it under xAI, Google, OpenAI, and DeepSeek — newest first within each vendor, so xAI reads 4.6 above 4.5 above 4.3, Google reads 3.8 above 3.7 above 3.6 above 3.5 above 3, and OpenAI reads Sol above Terra above Luna — the check sits on **Default**, and the checked entry is exposed as the checked radio item to assistive technology. A count is deliberately not written here: the contract is the list, and a number in this step would be a third copy of it to keep in step.
4. Without touching the selector, create a work stream. Confirm its `harness_runs.model` is what `agent-model-workstream` serves and `workstreams.model_override` is `NULL`.
5. Choose a different model, confirm the trigger and tooltip both take its name, then create a work stream. Confirm `workstreams.model_override` holds the chosen id, the run's `harness_runs.model` matches it, and the inference ledger records that model with no fallbacks.
6. Point `agent-model-workstream` at a variation other than the Worker-variable default, then confirm an untouched selector still reads **Default** rather than claiming a model — the served variation is not visible to the client and must not be guessed at.
7. Pin explicitly to **Grok 4.3** — the model `agent-model-workstream` serves by default, which since the families were ordered newest first is no longer the menu's first entry — confirm the trigger changes from **Default** to **Grok 4.3**, and confirm the created work stream carries that id: an explicit pin to the flag's own default must be distinguishable from never having touched the control. Then pin **Grok 4.6**, which *is* the first entry, and confirm it moves the trigger off **Default** just the same. Running both is the point of the step now that the two facts have come apart — the control reads a pin, not a position and not agreement with the flag, and either one alone would leave the other unproven. Then choose **Default** again and confirm the next work stream is created with no override.
8. Open a work stream that has run and confirm its composer shows the same control in the same place, chevron and all, and that it is disabled: no menu on click or on Enter, skipped by Tab, reported as disabled to assistive technology, and carrying the run's full model id in its accessible name. Confirm it stays legible at its dimmed opacity, and that hovering still raises the tooltip with that same id — the disable stops the menu, not the tooltip. Check it against `harness_runs.model` for that work stream's latest parent run — on a pinned one that is the pinned id, on an unpinned one it is whatever the flag served, which must be named rather than shown as **Default**. Point the flag at a variation serving a model outside `AGENT_MODEL_OVERRIDES`, start a work stream, and confirm the pill names it (shortened past the vendor prefix) rather than falling back to **Default**. Confirm the two work streams make different claims: the pinned one's tooltip says every run uses that model, the unpinned one's says the flag decides each run and a later run may differ. Then move the flag to another variation, send a message to the unpinned work stream, and confirm the pill follows the new run — proving the unpinned wording rather than the pinned one.
9. Pin a work stream and make its run fail before it streams a token — an invalid `OPENROUTER_API_KEY` does it — so `harness_runs.model` settles as `NULL`. Confirm the pill still names the pinned model rather than **Default**: a pinned work stream never consults the flag, so describing it as following one is wrong rather than merely vague.
10. Create a work stream with a model pinned and confirm the pill on the work-stream screen it opens onto already reads that model, without a **Default** frame in between as the screens change hands.
11. Repeat for an automation with a `model_override` on its row: draft it in its own conversation, apply it, and exercise every trigger (**Run now**, a scheduled run, a run triggered by matching connector activity, and a run started by mail to the automation's address), confirming each run's conversation carries the override and each run uses it. All four go through the one producer, `AutomationDO.provisionRun`, reading the pin from the automation row through `readRunDefinition`; the point of exercising all four is that a pin has to survive into a trigger that fires days later.

## Durable automation lifecycle acceptance

Use a disposable workspace and inspect both the global work-stream sidebar and
the Automation home page.

1. Select **New automation**, type without sending, navigate away, and return.
   Confirm there is no sidebar draft or automation ID. Send one prompt, then
   confirm the same screen adopts `/automations/<id>` and one draft row appears.
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
   `automation_set_evaluator_rules` before submission. Send matching,
   nonmatching, wrong-case, duplicate, and reordered connector events; only the
   matching canonical event creates one occurrence.
5. Watch the same resource from two work streams and trigger the automation from
   one update. Confirm WorkspaceDO creates three destination receipts and each
   destination receives exactly one update. Disable one watch before delivery
   and confirm that destination refuses safely.
6. Run the active automation manually. Confirm its generated work stream is
   absent from the global sidebar, appears once in the automation's paged run
   list, opens only after current child-audience authorization, and survives a
   retry without creating another child.
7. Delete the automation. Confirm its evaluator registrations are withdrawn, its
   schedules stop, its directory row goes to `deleted` and leaves the sidebar,
   and each generated child work stream is **archived** — archived, not deleted:
   the run record survives the automation that produced it. Confirm the Global
   email claim still stands (it is a permanent tombstone) and that mail to the
   address is refused rather than routed.
8. In a real Electron window, compare settled, streaming, failed, elicitation,
   attachment, follow, and **Jump to latest** behavior with a work stream. Confirm
   work-stream-only participant/resource/unread controls and automation-only
   review/template controls do not leak across adapters.

Pass evidence: one stable automation ID, one accepted authority, strict event
matching with one occurrence per canonical event, private generated runs shown
only on the automation home, recovered draft/compiler state, and no legacy
subscription/run table reads.

## PRD flow 1 — ad hoc collaboration

Use a test workspace with two members, Adam and Samantha.

1. Sign in and create **CFO of Calm** with Samantha selected before submission.
2. Confirm both people appear under **Participants** in the middle sidebar and Rally does not.
3. Send an opening instruction and observe a real OpenRouter response stream into the transcript.
4. Attach a small text or PDF file, open **Context**, and confirm the resource appears without exposing storage identifiers or credentials.
5. Open the same work stream as a third workspace member. Confirm **Viewing now** shows that person separately and does not add a participant row.
6. Reload both clients and confirm the transcript, people, and resource remain durable while viewing presence disappears when the second client closes.

Pass evidence: one work stream, two persistent participants, no Rally participant, one persisted attachment, one completed harness run, and no participant row for the viewer.

## Ordered transcript and mid-stream-open acceptance

1. Open a work stream whose first unread turn is at least ten conversation
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
4. Trigger automatic compaction twice in one long-lived work stream. After each
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
3. Run it manually. Confirm exactly one run work stream, successful `web_search` and selected `web_fetch` tool events, source-linked output, and a completed gray work-stream state.
4. Retry the same manual-run request with its original idempotency key. Confirm the existing run and work stream are returned and no second harness launches.
5. Let the next recurrence become due and confirm it creates the next planned work stream while preserving the following schedule.

Pass evidence: one initial manual run, one scheduled recurrence, authoritative source links, and no duplicate for the manual retry.

## PRD flow 3 — Google activity

Run this only in provider test accounts after enabling the five Google APIs and registering the OAuth callback URLs in `docs/provider-apps.md`. Keep an existing grant on the test account while exercising the second preset: the authorization request must send `include_granted_scopes=false`, and neither the consent screen nor the returned token may inherit scopes from that earlier connection.

### Mail + Calendar preset

1. In Settings, choose **Google Mail + Calendar** and confirm the Rally authorization request contains only `gmail.modify`, `calendar.readonly`, and `calendar.events` plus identity scopes. It must not request Drive, Docs, or Sheets scopes.
2. Exercise `google_gmail_search`, `google_gmail_read_thread` or `google_gmail_read_message`, and `google_gmail_create_draft`. Confirm the draft is present in the provider account, the tool event stores a provider operation reference, and the returned content is bounded/redacted. Do not call `google_gmail_send` during a production smoke test.
3. Exercise `google_calendar_list_calendars`, then use an explicit returned calendar ID with `google_calendar_list_events`, `google_calendar_read_event`, `google_calendar_create_event`, and `google_calendar_update_event` against a clearly named disposable event.
4. Establish Gmail and Calendar poll baselines, then create a new test message and modify the test event. Run the owning connector poll and confirm normalized `email.received`/`email.updated` and `calendar.event_changed` activity is persisted and queued before its cursor advances.
5. Bind a personal automation to the connection and confirm one activity creates one authorized work stream with visible tool events. Confirm a Docs or Sheets tool is rejected because this connection does not hold those capabilities.

### Drive + Docs + Sheets preset

1. With the Mail + Calendar grant from the preceding flow still present, choose **Google Drive + Docs + Sheets** and confirm the Rally authorization request contains only `drive.readonly` and `drive.file` plus identity scopes. It must send `include_granted_scopes=false`; the returned token and stored grant must not contain Gmail or Calendar scopes.
2. Exercise `google_drive_search` and `google_drive_get_metadata` against both a Rally-created file and an arbitrary existing file. Confirm `isAppAuthorized`, `canEdit`, and `writableByRally` distinguish per-file write access correctly; also verify one bounded `google_drive_download` or `google_drive_export` result.
3. Exercise the native Docs tools against a Rally-created file: create a document with `google_docs_create_document`, read it with `google_docs_read_document`, append text with `google_docs_append_text`, and replace an exact fixture string with `google_docs_replace_text`. Confirm an arbitrary existing Doc found only through Drive search is readable but not writable without a separate per-file grant.
4. Exercise the native Sheets tools against a Rally-created file: create a spreadsheet with `google_sheets_create_spreadsheet`, inspect it with `google_sheets_read_spreadsheet`, write an explicit A1 range with `google_sheets_update_values`, append rows with `google_sheets_append_values`, and read the result with `google_sheets_read_values`. Confirm an arbitrary existing Sheet found only through Drive search is readable but not writable without a separate per-file grant.
5. Establish the Drive change-token baseline before editing the Doc and Sheet. After both edits, run the connector poll and confirm the same Drive poll emits `docs.document_changed` and `sheets.spreadsheet_changed`, persists/queues them once, and then advances the Drive cursor. No Google webhook or push delivery should be involved.
6. Bind an automation to this connection and confirm Gmail and Calendar tools are rejected because the connection does not hold those capabilities.

Finally, revoke a test provider grant and repeat an affected read. Confirm the connection changes to **Reconnect required**, dependent work stops safely, and no token or raw provider response body appears in the desktop or logs.

Pass evidence: two independently selectable preset connections, exact stored capability sets, bounded native Docs and Sheets operations, Mail/Calendar and Drive cursors, one Drive-derived Doc activity, one Drive-derived Sheet activity, one authorized automation run per tested connection, and a sanitized reconnect state. Sending email is not required for this flow.


## Flow 9 — inbound work-stream email

1. Create one Global and one EU work stream and confirm each exposes an immutable four-segment address at `automation.rallywith.ai`.
2. Send plain text to both addresses. Confirm one verified `email.received` event creates one regional email resource and one system transcript message in each target.
3. Replay the same Resend delivery and confirm no duplicate resource or message is created.
4. Send to an unknown alias and confirm the webhook is acknowledged without attaching it anywhere. Send HTML containing script-like content and confirm Rally never renders or executes it.
5. Confirm the Global database does not contain the EU email body and that inbound mail does not automatically start an agent run.

## Flow 10 — inbound automation email

1. Create personal and workspace automations in both Global and EU and confirm each exposes a permanent four-segment address from the same account-wide namespace as work streams.
2. Send one message to each address. Confirm each owning region stores the untrusted email resource, creates exactly one work stream and automation run, records the automation owner as creator and participant, and passes only that labelled opening message to the harness. Confirm personal automations create private work streams another workspace member cannot list or read, while workspace automations create workspace-scoped work streams and resources that member can read.
3. Replay the same Resend email ID while processing and after completion. Confirm an active lease returns a retryable response, an expired lease can be reclaimed, and the completed replay returns the original work-stream and run IDs without launching again.
4. Pause an automation and confirm its route is disabled and mail cannot start a run. Resume it and confirm the exact same address is active again.
5. Confirm a work-stream reservation cannot claim an automation email address (or vice versa), even across regions, and that removing an owner leaves a permanent tombstone. Confirm the same local part on a different accepted domain remains a distinct claim.

## PRD flow 5 — future scheduled run

1. Create a Monday calendar automation in a timezone with daylight-saving transitions and open its next planned run from the automation screen.
2. Post pre-run instructions. Confirm the posting user becomes a participant and the work stream remains **Scheduled**.
3. Fire the workspace scheduler for that planned time, including one repeated alarm delivery.
4. Confirm the same planned work stream becomes **Running**, exactly one automation run and harness run are linked, and the pre-run message is included in the bounded model context.
5. Complete the run and confirm the next planned work stream uses the correct local Monday time across the next daylight-saving boundary.

Pass evidence: the planned work-stream ID is reused, the uniqueness key on subscription plus planned time prevents a duplicate, pre-run context reaches the harness, and the next local occurrence is correct.

## Flow 11 — Slack Agent connector

1. Validate `config/provider-apps/slack.json` with Slack CLI 4.4.0 or later and install the development app in two Slack test workspaces.
2. Connect both Slack installations to one Rally workspace. Confirm two `Slack · <team>` workspace connections exist and each bot durably joins every existing public channel. Reconnect one installation and confirm the idempotent sync runs again. Attempt to connect either Slack team to a different Rally workspace and confirm `slack_workspace_already_connected`.
3. Open each app Home as an unlinked user. Confirm onboarding, privacy/help, and a **Connect Rally** button that carries no link of its own — copying its address must offer nothing. Leave Home open for more than fifteen minutes, then click it: confirm a modal opens with one **Open Rally** handoff, and that the handoff still works, because nothing on the published view expires. Click **Connect Rally** a second time and confirm the earlier modal's link is refused as already used rather than as expired. Mark the installation for reconnect and confirm the click explains the reconnect instead of offering a link that cannot be redeemed. Link one Rally member and confirm Home changes to quick actions, active tasks, automations, and notifications.
4. Create a public Slack channel and confirm the `channel_created` ingress job makes Rally join it. Send a new Agent DM, a threaded follow-up, and a channel mention. Confirm Rally adds `👀` to each exact triggering message before a workstream or model run starts, each root maps to one `slack_agent_sessions` row, follow-ups reuse the workstream, status appears, and completion stops the stream or posts the fallback thread reply. Replay a claimed job after the reaction succeeds and confirm Slack's `already_reacted` response does not duplicate or fail the task.
4a. Watch the reaction through a whole run. Confirm the triggering message carries `👀` and nothing else within a second; that the reaction changes at least once while the run is live and each value comes from the working set; and that when the run ends the message carries exactly one reaction matching its outcome — `✅` completed, `❓` needs input, `⚠` failed, `🛑` stopped. React to the same message yourself with an unrelated emoji and confirm it is still there at the end. Reply again in the same thread and confirm the reaction moves to the new message and the rotation restarts. Force a run to fail after acknowledgement and confirm the outcome reaction still lands, since delivery rather than the rotation applies it.
4b. Configure a workspace reaction override on the installation's `config_json`. Confirm a partial override changes only the states it names; confirm an override naming a nonexistent emoji falls back to Rally's default for that state, logs the rejected name, and does not fail the run.
4c. Post an automation result containing a heading, an ordered list, a table, and a fenced code block. Confirm all four render as formatted content in the Agent DM with no literal `#` or `**` characters, and that the title is a header above the body rather than a line of it. Compare a streamed reply and a fallback reply carrying the same content and confirm they render identically. Post a result long enough to split and confirm the break lands on a paragraph seam and that a code block spanning the break arrives as two valid blocks rather than one severed one.
5. Mention one linked Rally teammate and one unlinked teammate whose verified email matches exactly one active member across the installed Slack teams. Confirm both receive one bot-authored Agent DM and the unlinked teammate does not gain a `slack_user_links` record. Repeat with no match, matches in two teams, a cross-team result, and a missing `users:read.email` grant; confirm each falls back to the existing mention email, and the additive missing scope does not disable existing Agent features.
6. Invoke both shortcuts and `/rally`; confirm the modal opens in under three seconds, submissions create tasks, and malformed/replayed signatures are rejected.
8. Mention Rally in a **public** channel from a linked member, then reply in the same thread as (a) a second linked member, (b) a member with no Slack link whose verified email matches an active Rally member, and (c) a member Rally cannot map at all. Confirm every reply is taken — none is refused — that the first two are recorded under their own Rally identities and the third under its Slack actor, and that the work stream is `public` in Rally. Repeat the whole case in a **private** channel: confirm the work stream is `private`, that it opens already holding the channel's mappable members, that a member who was not in it when it started is seated by their first reply, and that a member of the workspace who is *not* in the Slack channel cannot open it in Rally.
7. Redeliver the same Events API `event_id` and body; confirm it is acknowledged once. Reuse the ID with different bytes and confirm the conflict is recorded. Force the first regional worker attempt to fail and confirm the durable queue retries the same ingress job instead of permanently deduplicating the failed receipt.
9. From an Agent DM and an app mention, ask Rally to find a message, identify a user/channel, read message/channel/thread/file/member context, and cite the returned permalink. Confirm `assistant.search.context` receives the event's `action_token`, public-only channel types, and a maximum of 20 results; confirm the token is absent from model prompts and tool arguments. Start the same search outside Slack with only the workspace connection and confirm it fails with a user-initiated-search explanation. Confirm specific reads still work without an action token when the bot can access the target conversation.
10. Ask Rally to send a message, add a reaction, and create a public channel, a private channel, a DM, and a group DM through the workspace installation. Confirm the normal write confirmation/receipt gate, bot attribution, stable `client_msg_id` on messages, idempotent `already_reacted` handling, and no duplicate provider mutation after a workflow retry.
11. Add a personal Slack connection and confirm the row carries
`slack.personal.mcp`. Load it from a work stream and compare the exposed names
and input schemas with Slack's current `tools/list` response rather than a
checked-in expected list. Exercise one tool with `readOnlyHint` and one without;
confirm both receive write confirmation and a record-before-execute receipt,
because provider annotations never downgrade Rally policy. Confirm another
Rally member cannot load or use the connection.
12. Copy a work-stream link from the desktop header and confirm it is the
canonical
`https://rallywith.ai/app/workspaces/<region>/<workspace-uuid>/workstreams/<workstream-uuid>`.
Paste it into Slack and confirm the unfurl names the work stream — title, last
activity, and automation origin where it has one — and reveals no work-stream
contents. Confirm a running, needs-input, or failed work stream leads its title
with the matching emoji and repeats the word below it, and that a completed one
shows no badge at all. Paste a current link addressed to another Rally workspace
and confirm this installation refuses to unfurl it rather than resolving the ID
against its own workspace. Repeat in a Slack Connect channel and confirm the
same refusal. Then move the work stream from needs-input to completed, wait for
the five-minute maintenance sweep, and confirm the posted card rewrites itself
in place — losing its badge — without adding a second attachment. Confirm a card
whose status has not moved is left alone, and that a move between two unbadged
states (completed to idle) also leaves the posted card untouched. Then rename
the work stream inline from its header without changing its status, and confirm
the posted card picks the new title up on the next five-minute sweep. Change
only the objective, which the card never shows, and confirm no second attachment
appears and the card is not rewritten. Open the link in a browser and confirm it
hands off to the desktop app; open one with a malformed id and confirm the page
says so instead of offering a dead button. Paste a legacy
`/open#target=avalon://workstreams/<uuid>` link and confirm it still unfurls only
within the Slack installation's own workspace; paste a bare
`rallywithai://workstreams/<uuid>` and confirm no unfurl is expected, since Slack
delivers no event for it.
13. Create “Check my Gmail every morning and send me the stack-ranked top 3 emails in Slack,” select one Slack Agent DM destination, and inspect the stored frozen target. Run it with three, one, and zero qualifying emails. Confirm the complete ranked Slack output and controls, fewer-than-three behavior, and default empty suppression.
14. Revoke Gmail, then Slack. Confirm each run/destination moves to `needs_input`; no alternate account or Slack installation is selected.
14. Repeat an Agent DM and automation delivery for an EU Rally workspace. Confirm Global stores only the opaque team route, the EU WorkspaceDO owns links/session/delivery state, and the EU work-stream objects own the task and result.
15. Expire a rotating Slack credential and start two simultaneous connector operations. Confirm exactly one `oauth.v2.*.access` refresh consumes the old refresh token and both operations continue with the newly persisted token pair.

## Flow 12 — Notion personal MCP and workspace connector

1. As a regular Rally member, open **Connections** and confirm Notion offers **Connect for me**. As an owner or administrator, confirm it also offers **Connect workspace**; the two actions must remain visibly distinct.
2. Start **Connect for me**. Confirm authorization uses Notion's official hosted MCP flow, then inspect the resulting row: it is personal, owned by the initiating Rally user, grants `notion.personal.mcp`, stores a DCR client and rotating credential, and creates no `notion_workspace_routes` row.
3. From that member's fresh ad-hoc work stream, load Notion and compare the exposed names, descriptions, and input schemas with the server's current `tools/list` response. Use a current read tool, then a current mutation tool against disposable content. Confirm both receive confirmation plus a durable receipt regardless of provider annotations, and confirm another Rally member cannot load the personal connection.
4. Expire the personal access token and start two simultaneous MCP operations. Confirm the credential lease redeems the rotating refresh token once, persists the returned pair, and both operations continue. Revoke the grant and confirm the connection becomes `needs_reconnect`.
5. As a Rally owner or administrator, start **Connect workspace**, approve it as a Notion user, and select a disposable page plus one data source in the page picker. Confirm the resulting row is workspace-scoped with no owner user even though its encrypted credential metadata records the approving Notion user and installed bot.
6. From a fresh ad-hoc work stream started by another Rally member, search for and read the selected page without attaching it first, then add a clearly marked comment and edit disposable content. Confirm Notion attributes both mutations to the Rally integration bot rather than to the OAuth approver. Confirm an unselected page remains inaccessible.
7. Change the selected page in Notion and confirm the signed webhook becomes one normalized workspace activity with no target user. It must be visible to the workspace opportunity pipeline rather than partitioned to the approver.
8. Bind the workspace connection explicitly to a workspace automation and confirm its fixed Notion API tools work. Confirm an automation without that binding does not acquire the connection merely because ad-hoc work streams do.

Pass evidence: one owner-only personal MCP connection whose tools match the
live server, one admin-authorized workspace bot connection, member isolation,
serialized rotating refresh, bot-attributed mutations from a second member's
work stream, one workspace-scoped webhook activity, and explicit automation
binding.

## Provider and deployment note

Flows 2 and 3 require external services and are release gates for a hosted test workspace, not for an offline local build. Follow the regional deployment checklist in `docs/runbook.md`; production smoke should create a Gmail draft unless an explicit send has been approved.

### Sidebar geometry and resizing

Both collapsed navigation sidebars are 96 CSS pixels wide, allowing symmetric
space around the macOS traffic lights. Their navigation controls, including
Search and New substream, are 54-pixel squares with 9-pixel padding. Collapse
controls sit at the bottom; the account avatar and navigation toggle remain
side by side. The main conversation row uses the work-stream title.

Check each bottom toggle and double-click each right edge to collapse and
expand. Drag short of the expansion/collapse threshold and confirm a faint
vertical guide follows the pointer; release or cancel and confirm it disappears.
Check both appearances, long titles, and a short window: account and collapse
controls must remain visible while the content scrolls.

Public work streams show the globe in the glyph's upper-right corner, above
the status badge. Both badges have a surface-colored cutout and stay attached
to the glyph in expanded and collapsed navigation. Check public and private
rows, selected and hovered rows, and light and dark appearances.

In collapsed navigation, Search and New chat are the first two items inside
the same vertical scroller as work streams and Sidekicks. Scroll a long list
and confirm both move out of view while the account and collapse controls
stay fixed at the bottom.

Hover a public stream icon and then move onto its globe in both appearances.
The globe stays visible and only the stream preview opens; the public badge
has an accessible label rather than a competing nested tooltip.

When a narrow window forces navigation into compact mode, its Expand control
is disabled and double-clicking the edge must preserve the saved expanded
preference. Widening the window restores expansion. Clicking either separator
must focus it so ArrowLeft/ArrowRight can immediately resize it. Public stream
links expose their visibility as an accessible description; the compact center
sidebar's bottom toggle is centered in the same icon column as its rows.
