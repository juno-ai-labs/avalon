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
| `apps/desktop/src/renderer/styles/app.css` | Settings layout and reveal treatment; appearance ownership is in [theming](theming.md). |
| `apps/desktop/src/common/settings.ts` | Section identities shared with the desktop window. |
| `apps/desktop/src/renderer/settings/digest-provider.ts` | Connection-backed digest destination definitions. |
| `apps/desktop/src/renderer/settings/search-results.tsx` | Result navigation and lazy target revelation. |
| `apps/desktop/src/renderer/screens/workspace-settings.tsx` | Existing settings bindings, authorized connection providers, section selection and availability. |

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

### 2026-09-05 — Verify review findings before merging (#557)

**What changed:** Restored discovery aliases, indexed MCP setup policy, aligned provider actions with scope, keyed permission option labels, and made reveal cancel on navigation, interaction and failed reads. Replayed metadata no longer throws during render.

**Why:** Review exposed real discovery regressions and late-focus hazards not exercised by the original happy-path tests.

**Considered and rejected:** Arbitrary observer timeouts would race slow legitimate reads. Removing setup discovery contradicts the requirement that all settings be searchable. A general plugin or form engine remains unnecessary.

**Consequences:** Search remains read-only; cancellation and instance identity now have direct regression coverage. Action labels do not receive keyboard activation focus.

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
