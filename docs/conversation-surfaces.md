# Shared conversation surfaces

Rally's work-stream feed and automation draft wizard are two adapters over one
renderer conversation family. They share presentation and interaction
primitives, not product authority or one stateful screen component.

## Where the code lives

- `apps/desktop/src/renderer/components/conversation-follow.tsx` owns the
  transcript viewport, follow controller, and **Jump to latest** integration.
- `apps/desktop/src/renderer/components/message-feed.tsx` and the message/card
  components it composes render ordered human, assistant, tool, activity,
  attachment, and failure rows.
- `apps/desktop/src/renderer/components/expanded-composer.tsx`,
  `use-draft-text.ts`, and `use-file-attachments.ts` provide the common composer
  shell, local text persistence, and staged-file lifecycle.
- `apps/desktop/src/renderer/screens/workstream.tsx` adapts a SubstreamAgent feed.
  Its tool rows are not rendered one per call: they collapse into one row per
  plugin, which [`plugin-activity-rows.md`](plugin-activity-rows.md) owns
  entirely. The automation adapter below deliberately keeps a row per call.
- `apps/desktop/src/renderer/screens/new-automation.tsx` adapts an AutomationAgent
  draft feed.

## Contract

Both adapters provide canonical ordered turns, loaded coverage, streaming
blocks, activity timing, attachment actions, retry/stop state, and a stable
conversation identity. The common viewport follows only while the reader owns
the latest edge; scrolling transfers ownership to the reader until **Jump to
latest** is selected. Programmatic repositioning is announced before changing
`scrollTop`, and reduced-motion preference controls whether the jump animates.

Sharing stops at product semantics. Work streams retain participants, unread,
resource, run, and steering controls. Automation drafts retain templates,
definition review, acceptance, compiler retry/stop, and structured elicitation.
Neither adapter may smuggle those controls through an optional common prop.

The route host, not the feed, owns identity transitions. A new work stream and a
new automation begin with local composer keys; after durable admission their
adapter rekeys text/files and adopts the server identity without remounting the
conversation family. Socket snapshots remain authoritative after reconnect;
local optimistic rows are reconciled by stable client turn IDs.

## Testing

Shared components have fixture-level component tests for settled, streaming,
failed, elicitation, attachment, tool, follow, and paging states. Each screen
adapter separately proves its controls and identity transition. Any visible
change also requires a real Electron-window check because DOM assertions cannot
prove layout, focus, scroll position, or overlap.

## Changelog

### 2026-08-28 — Work streams and automation drafts share one conversation family

**What changed:** Feed, composer, attachment, message action, follow, and jump
behavior were extracted from WorkstreamScreen and adopted by the Automation
Draft Wizard through explicit adapters.

**Why:** The two products have the same conversation mechanics but different
authorities and controls; duplicating the mechanics had already produced
different streaming and scrolling behavior.

**Considered and rejected:** Reusing WorkstreamScreen itself would make an
automation draft pretend to have participants, unread state, resources, and a
SubstreamAgent identity. A second wizard-only feed would preserve divergence.

**Consequences:** Shared interaction changes need coverage in both adapters,
while product-specific controls remain locally typed and visibly absent from
the other surface.
