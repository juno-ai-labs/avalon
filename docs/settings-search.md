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
| `apps/desktop/src/renderer/settings/choices.ts` | Digest choices and value-keyed permission labels shared by controls and search. |
| `apps/desktop/src/renderer/components/primitives.tsx` | `SegmentedControl`, the one exclusive-choice strip the appearance preference and the connections filter both draw. |
| `apps/desktop/src/renderer/styles/app.css` | Settings layout and reveal treatment; appearance ownership is in [theming](theming.md). |
| `apps/desktop/src/common/settings.ts` | Section identities shared with the desktop window. |
| `apps/desktop/src/renderer/settings/digest-provider.ts` | Connection-backed digest destination definitions. |
| `apps/desktop/src/renderer/settings/search-results.tsx` | Result navigation and lazy target revelation. |
| `apps/desktop/src/renderer/components/sidebar-search.tsx` | Search control shared by the main and Settings sidebars. |
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

`SettingsProvider` supplies entries with unique keys. The core provider derives
entries from the definitions. Connection providers derive entries from the
already-authorized connection snapshot: GitHub and MCP entries retain the
connection ID, installed connections expose their management row, and digest
destinations use the same delivery capability that makes their control visible.
The connector catalogue supplies setup entry points even before connecting.

Typing searches labels, descriptions, section names, options, aliases and
instance labels. Matching ignores case, surrounding whitespace and combining
accents; all query words must occur. Exact labels rank above prefixes,
substrings and other metadata. It does not fetch remote indexes or mount
inactive pages. Results replace navigation while the query is non-empty;
typing does not change the active page.

Sections are pages, and a page may be indented under the one it belongs to.
`internet-access` sits under `workspace` and `github` under `connections`; the
child is a section in its own right, with its own definitions, its own read and
its own deep link, not a scroll position inside its parent. `sectionLabels` in
`search-results.tsx` is typed as a total record of the section list, so adding a
section that nobody named fails the build rather than shipping a search result
whose page name is blank.

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
provider's setup entry point. The reader must choose personal/workspace scope
and start setup themselves. Search never creates a connection merely to show a
field whose value only exists after creation. A visible explanation describes
this handoff. Conditional network-domain and repository-default controls show
why they are inapplicable when searched, rather than leaving a search destination missing.

The Connections pane ends at the connector grid, without a page-level success
or error log. Connection status remains on the cards, and setup dialogs retain
their own validation feedback.

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
actions. The existing settings, digest, theme and icon behavior tests continue
to cover persistence bindings. Use the desktop renderer Vitest lane; backend
services and Electron IPC are existing test doubles, not assertions about live
authorization. Real Electron checks cover positioning, keyboard navigation,
scrolling and both appearances.

## Changelog

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
