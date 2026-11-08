# Settings registry and search

Settings definitions supply both visible control text and local search metadata.
Search reveals individual controls, including controls on unmounted pages,
without maintaining a second list of section keywords.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/settings/registry.ts` | Definitions, availability contract, provider collection and matching. |
| `apps/desktop/src/renderer/settings/setting-label.tsx` | Shared labels, descriptions and inert focus targets. |
| `apps/desktop/src/renderer/settings/setting-toggle.tsx` | Registry-backed switch presentation with existing state and mutation bindings. |
| `apps/desktop/src/renderer/settings/choices.ts` | Value-keyed permission labels shared by controls and search. |
| `apps/desktop/src/renderer/components/primitives.tsx` | `SegmentedControl`, the one exclusive-choice strip the appearance preference and the connections filter both draw. |
| `packages/ui/src/styles/app.css` | Settings layout and reveal treatment; appearance ownership is in [theming](theming.md). |
| `apps/desktop/src/common/settings.ts` | Section identities shared with the desktop window. |
| `apps/desktop/src/renderer/settings/search-results.tsx` | Result navigation and lazy target revelation. |
| `apps/desktop/src/renderer/components/sidebar-search.tsx` | Search control shared by the main and Settings sidebars. |
| `apps/desktop/src/renderer/components/organization-usage.tsx` | The Usage section of the Organization pane and the Organization menu's usage line. |
| `apps/desktop/src/renderer/screens/workspace-settings.tsx` | Existing settings bindings, authorized connection providers, section selection and availability. |

The window these panes are drawn in, and what the screen may render before its
workspace read returns, belong to [`settings-window.md`](settings-window.md).

## How it works

Define a setting with a stable ID, section, label, description and kind. The
definition is available at module load, not registered by mounting its control.
Render its text with `SettingLabel` or `SettingCopy`; bind the existing control
and mutation hook beside it. Options can come from the same option data the
control renders. Optional aliases describe genuine synonyms, not a parallel
search catalogue.

The Application page's **Update channel** is a device-local desktop preference.
It renders through the shared dropdown and is indexed from the same Stable and
Faster option labels. Browser fallback surfaces omit it because they cannot
configure Electron's updater.

A browser has no **Desktop app** group at all: every Application setting but
appearance configures the Mac app itself. Appearance moves to Account there, under
its own definition (`accountAppearance`) gated on the `browser` availability, so
search sends a browser reader to Account and a Mac reader to Application.

`SettingsProvider` supplies entries with unique keys. The core provider derives
entries from the definitions, leaving out those with a `connectionKind`.
Connection providers derive entries from the already-authorized connection
snapshot: each installed connection is an entry for its own page, its
`connectionKind` definitions are repeated once per matching connection, both
retaining the connection ID.
The connector catalogue supplies setup entry points even before connecting.

Typing searches labels, descriptions, section names, options, aliases and
instance labels. Matching ignores case, surrounding whitespace and combining
accents; all query words must occur. Exact labels rank above prefixes,
substrings and other metadata. It does not fetch remote indexes or mount
inactive pages. Results replace navigation while the query is non-empty;
typing does not change the active page.

Sections are pages, and a page may be indented under the one it belongs to.
Installed connections sit under `connections`, and `members` (the roster,
guests and invitations) sits under `workspace`. A child page is not a scroll
position inside its parent: it has its own definitions, its own read and its
own deep link. `sectionLabels` in
`search-results.tsx` is typed as a total record of the section list, so adding a
section that nobody named fails the build rather than shipping a search result
whose page name is blank.

A guest sees every section. The ones a guest cannot open (everything but
Account, Members and Application, per `GUEST_SETTINGS_SECTIONS`) are drawn
disabled with the reason in a tooltip, never hidden. A disabled section is left
out of `SettingsSearchContext.sections`, so search never lands on one, and a
link that names one opens Account instead.

`connection` is one section shared by every installed connection; the selected
connection ID names the instance, the same pair a search result carries. Its
sidebar items, table rows and search entries all set both. Definitions with a
`connectionKind` appear only on the pages of connections whose `settingsKind`
matches. A `connection` request with no live connection, including a deep link,
lands on Connections once the list has loaded.

A section's id is its deep link, so it outlives the label. The **Security** page
keeps the id `internet-access` from when it was called Internet access. A page
that is removed or folded into another keeps its old id as an alias:
`parseDesktopSettingsSection` still reads `digest` as `notifications`, because
digest emails already sent and older builds link to it, though the digest
settings themselves are gone. Search
indexes the id, not the label, so a renamed page carries its visible name as an
alias on its definitions.

Both sidebars render `SidebarSearch` with the same sizing, typography, icon and
focus treatment. The main window uses its button mode to open workspace search;
Settings uses its input mode with the local settings index and keyboard handlers.
The Settings sidebar also shares the main sidebar's canvas, border, idle text,
hover and selected-row color rules. These apply to child navigation entries and
search results; a selected section keeps its selected fill while hovered.

Selecting a result sets its section and, when applicable, connection selection.
The existing pane performs its normal read. An observer waits for the inert
target, then scrolls it into view, focuses it and highlights it. Replacing the
request, leaving its section, a failed destination read, or further user interaction disconnects the observer. Action labels inside buttons are scrolled and highlighted without focusing their activatable ancestor. Arrow keys navigate
results; Enter activates a result; Escape clears search before closing a window.

Setup fields such as MCP authorization or webhook signing secrets point to their
provider's setup entry point. The reader must choose personal or Organization scope
and start setup themselves. Search never creates a connection merely to show a
field whose value only exists after creation. A visible explanation describes
this handoff. Conditional network-domain and repository-default controls show
why they are inapplicable when searched, rather than leaving a search destination missing.

The Connections pane ends at the connector grid, without a page-level success
or error log. Connection status remains on the cards, and setup dialogs retain
their own validation feedback.

Ashby setup exposes the exact labels **Connect for me** and
**Connect for organization**; the latter requires Organization administration. Exact
searches for either label filter by the available scope. API-key searches reveal the setup entry point rather than creating a connection.
Organization setup has no event selection: Rally manages Ashby subscriptions
automatically, while Sidekicks choose which event types they use.
Personal owners can refresh their own OAuth connection. Administrators manage
Ashby installations through **Manage events** on the connection's page; no
other connector's page offers it. The main view shows
plain status, the last event and explained **Test**, with **Get help** when needed.
**Advanced** contains saved-status refresh, API-key replacement and technical
recovery; subscription diagnostics are collapsed separately. Cleanup retry is
shown only when provider removal is incomplete. The
workspace connection notification refreshes both list and installation queries,
so open details do not retain a pre-repair snapshot. Management is unavailable
offline; [installation lifecycle](connector-installation-lifecycle.md) owns its
authorization and provider effects.

## Invariants

- Labels and descriptions belong to definitions. Duplicating them in a keyword
  catalogue would make a newly added setting silently unsearchable again.
- Search availability uses the same section, role, platform and developer
  availability as presentation. Disabled controls remain discoverable.
- Keys are unique across providers. Static uniqueness is tested; repeated provider
  metadata is deduplicated so a replay cannot crash the settings window.
- Search targets are inert. Focus must not click a checkbox, submit a form,
  authorize a connection, sign out or bypass an existing confirmation.
- Connection instances retain identity through selection and lazy loading.
  Losing it could send the reader to another connection's permissions.
- Index metadata, not field values: credentials, header values, webhook secrets
  and user-entered drafts never enter the index.

## Boundary

This module owns discovery and navigation, not persistence, authorization,
provider requests or setting validation. Existing query/mutation hooks remain
authoritative. Custom settings keep their existing components: schedules,
tables, icon pickers, network previews, diagnostics and connector setup do not
need to become a generic form engine.

## Failure modes and limits

No matches leaves the current page visible with an explicit empty result.
Feature withdrawal removes corresponding results. Async read failures retain
the existing pane's error UI rather than triggering a mutation or guessing a
different target. Observer cleanup follows navigation and component lifetime;
there is no polling, artificial result cap or search-specific network timeout.
Search is a local linear scan of the available definitions and provider entries.

## Testing

`registry.test.ts` proves definition-driven discovery, shared option labels,
ranking, availability, instance identity and replay deduplication.
`search-results.test.tsx` exercises multi-instance reveal, delayed rendering,
navigation and interaction cancellation, and action-button focus exclusion.
`workspace-settings.test.tsx` searches every core definition, waits for its real
rendered destination, and asserts that navigation does not execute consequential
actions. The existing settings, theme and icon behavior tests continue
to cover persistence bindings. Use the desktop renderer Vitest lane; backend
services and Electron IPC are existing test doubles, not assertions about live
authorization. Real Electron checks cover positioning, keyboard navigation,
scrolling and both appearances.

## Notifications

The `notifications` section is available only when the served
`pushNotificationsEnabled` flag is true. Its device-level switch is registered
in the same settings catalogue; unsigned builds explain that an installed release
is required. Permission denial exposes a System Settings action.

## Usage

The `workspace` section registers **Usage** (`settings.usage`) as an
information definition with no availability gate, so every member finds it,
whatever their role. Its description names the plan and the week's shared
quota, so "usage", "quota" and "plan" all reach it; "billing" and "limit" are
aliases. The heading is the inert target, and it renders in every state of the
section, loading and failed included, so a search result always has somewhere
to land. `components/organization-usage.tsx` draws the section;
[`local-cache.md`](local-cache.md) owns the row it paints from.

## Changelog

### 2026-10-24 — A guest sees every section, disabled where they cannot go

**What changed:** A guest's Settings sidebar draws every section. Notifications,
Organization, Security and Connections are disabled with a tooltip giving the
reason; Account, Members and Application open as before, and Members sits under
Organization again. Disabled sections stay out of search.

**Why:** Hiding what a guest could not use left them no hint that it existed or
why they could not reach it. The rule is now the same as the account menu's:
never hide, just disable.

**Considered and rejected:** The native `disabled` attribute, which takes the
button out of the tab order, so a keyboard user would never reach the reason.
The button uses `aria-disabled` and ignores the click instead.

**Consequences:** A new section a guest cannot open needs nothing extra: it is
disabled unless added to `GUEST_SETTINGS_SECTIONS`.

### 2026-10-24 — Members becomes its own page under Organization

**What changed:** The member and guest roster, the suspend and make-member
dialogs, and Invitations moved off the Organization page onto a new `members`
section, drawn as a child of Organization. The account menu gained a
**Members** item above **Sidekicks** that opens Settings on that page. Leaving
the organization stays on Organization: it is about the viewer's own access,
not about managing other people.

**Why:** The roster was at the bottom of a long Organization page, below
preferences, memory and usage, and there was no direct way to reach it. A page
of its own gives the account menu a destination to deep link to.

**Considered and rejected:** Scrolling to an anchor inside Organization. A
child page has its own deep link and its own search section, which a scroll
position does not.

**Consequences:** The `members`, `invitations` and invite-form definitions
declare `members` as their section, so search lands there. The invitation
accepted/declined email links to `settings/members`, which the deep-link
grammar in `@rally/contracts` now accepts; a link to `settings/workspace` still
opens Organization. A guest does not
see the page, as with every other Organization section.

### 2026-10-07 — Every connection gets its own page

**What changed:** The Connections sidebar entry lists every installed
connection beneath it, with its company mark, and each opens a page of its own.
The `github` and `custom-mcp` sections, which showed one connection of their
kind behind a dropdown, became the one `connection` section. A custom MCP server
wears the mark of a company its name spells out, so "Cloudflare API" draws
Cloudflare's.

**Why:** A workspace with two MCP servers had one **MCP tools** page and had to
pick a server from a dropdown on it, and a connection with no settings of its
own had nowhere to be looked at but a table row. One page per connection gives
each a place to be found, from the sidebar, the table or search, whatever its
kind. The table's inline actions moved onto the page, so the list is for finding
a connection and the page is for acting on it, and the two never disagree about
which actions a connection offers.

**Considered and rejected:** A section per connector kind, as before, keeps the
dropdown and leaves most connections without a page. Reading each custom
server's URL to choose its mark would cost one live request per server to draw
the sidebar; the name is already in the list.

**Consequences:** `connection` is meaningless without a connection ID, so
anything that opens it must also set one; a section request from the main
process names no connection, so it lands on Connections. A setting tied to one kind of connection declares `connectionKind` rather
than a section of its own. A server named for no known company draws the
generic server icon.

PR #1157.

### 2026-10-07 — Drop the Desktop app section from browser Settings

**What changed:** Browser Settings no longer lists the Desktop app group or its
Application page. The appearance picker moved into Account, and search gained a
`browser` availability so it finds appearance where each host shows it.

**Why:** In a browser the Application page held one working control and a note
that everything else lived in the Mac app. A section named for an app the reader
is not using was noise.

**Considered and rejected:** Moving the existing `appearance` definition to
Account on both hosts would split the Mac's device settings across two pages.
Making a definition's section depend on the host would break the rule that
definitions are fixed at module load.

**Consequences:** A setting that lives in different sections per host needs one
definition per section, each gated on the host that shows it.

PR #1155.

### 2026-09-15 — Make the desktop release channel a searchable device preference

**What changed:** Application settings gained a Stable/Faster update-channel
dropdown backed by the device preference file and the shared settings registry.

**Why:** Release pace is a choice for one installed Mac, while the release
service remains authoritative for which signed build each channel names.

**Considered and rejected:** Treating Stable as a slower poll of the same latest
manifest would still expose the same release immediately after a relaunch and
would not create an actual release channel. Storing the choice on an account or
workspace would unexpectedly move every installation together.

**Consequences:** Stable is the migration default for old or invalid preference
files. The browser hides the control, and changing from Faster to Stable never
downgrades an installed build. A channel change invalidates in-flight and staged
work from the old feed, disables its install-on-quit path, and checks the newly
selected feed as soon as the old updater operation settles.

### 2026-09-12 — Separate Ashby personal setup from shared event installation

**What changed:** The catalogue exposes exact scope-specific Connect labels and searchable Ashby key controls and automatic event subscriptions. Manage events shows status and explained Test, keeping key replacement and technical recovery in Advanced; personal owners can refresh their own OAuth grant.

**Why:** Setup and recovery must preserve personal versus administrator authority, and reading registration status or rotation instructions must not mutate the provider. Open details must follow the same pushed state as the connection list.

**Considered and rejected:** Fuzzy scope-label matches that expose workspace-only results, automatic repair during status display, or a rotation-guidance request that marks a current installation as failed.

**Consequences:** Availability and search share scope rules; workspace updates invalidate both connection and installation reads. Legacy Granola rows expose adoption through Test. Management actions remain unavailable offline.

PR #737. Design: [connector installation lifecycle](PRDs/2026-09-12_connector-installation-lifecycle/prd.md).

### 2026-09-10 — Internet access becomes its own page, and one strip draws every exclusive choice

**What changed:** The Terminal outbound-access policy moved out of Workspace
preferences onto an **Internet access** page indented under it, the way GitHub
sits under Connections. The Application pane lost the **Telemetry inspector**
along with its `telemetry:inspector` IPC channel, preload method and bridge
type, and **About** now lists the version alone rather than build, platform,
regional API base URL and a realtime line. The appearance picker and the
connections filter both render the new `SegmentedControl` primitive, and
`sectionLabels` became a typed total record of the section list.

**Why:** The policy is a review-then-confirm flow that stops running sandboxes,
and it had been sitting mid-list between a timezone dropdown and an invitation
form, where a destructive control reads like a preference. About was answering
questions nobody asks of a shipped app — the API base URL and the socket's
reconnect strategy are debugging facts, not installation facts — and the
inspector was a developer pane whose only reader was its own author. Two
segmented strips two panes apart had grown separate markup, separate CSS and
separate semantics (`radiogroup` in one, pressed buttons in the other) for the
same job.

**Considered and rejected:** Leaving the Terminal card in Workspace behind a
sub-heading keeps the destructive flow one scroll from the invite form.
Restyling the two strips to match without extracting a primitive is how they
drifted the first time. Keeping the inspector's IPC channel with the pane
removed leaves a renderer-reachable telemetry surface with no caller.

**Consequences:** `internet-access` is a section identity like any other: it is
deep-linkable, its settings carry it, and the Terminal read is gated on it
rather than on `workspace`. A new section that `sectionLabels` does not name is
now a type error. An exclusive-choice strip is a `radiogroup` everywhere, so it
costs one tab stop and its arrows move the choice.

### 2026-09-07 — Settings shares the main sidebar's search control and interaction colors

**What changed:** Settings uses the main sidebar's search component and visual
treatment, and its navigation and search results share the main sidebar's color
rules, including its canvas and border.

**Why:** The separate Settings input had drifted in height, border and
typography, and separate neutral and raised-surface tokens made Settings hover
and selected states look different from the same states in the main window.

**Considered and rejected:** Copying the main sidebar's styles into a second
control, or maintaining a second palette. Later appearance changes would still
have to be made twice, which is how the drift happened the first time.

**Consequences:** Grouped selectors keep the main window authoritative for both
the control and its colors, while local settings discovery is preserved.

### 2026-09-05 — Define settings once for presentation and discovery

**What changed:** Replaced section keyword filtering with setting definitions,
provider-backed instances, shared rendered metadata and inert reveal targets
across the current settings surface.

**Why:** Section keywords had to be maintained separately and could neither
discover newly added controls automatically nor take a reader to the matching
control on a long page.

**Considered and rejected:** Scraping mounted DOM omits unopened pages and risks
indexing secrets. A general persistence/form engine would unnecessarily replace
working mutation and confirmation flows. Opening setup automatically would
guess a connection scope and could start external authorization.

**Consequences:** New settings supply a definition and render that definition.
Providers extend the same index; complex panels retain their components.
Availability and focus-target coverage must change alongside new settings.
