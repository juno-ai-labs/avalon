# UI typography, visual density, and magnification ergonomics

> Created 2026-08-18.
>
> Modernize Avalon's typography, text density, visual hierarchy, and zoom capabilities across desktop surfaces based on empirical vision science and HCI research.
>
> Companion documents: [state](state.md).
>
> Standing brief: [Avalon implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Avalon will update its visual design hierarchy and display ergonomics to eliminate visual clutter, scan fatigue, and distance legibility collapse. The desktop application will adopt an upgraded typography baseline, standardized line-height and reading measure constraints, systematic visual chunking with progressive disclosure, and user-configurable magnification/density preferences (Default, Comfortable, and Compact).

These changes ensure that long work-stream transcripts, agent activity streams, and metadata rails comply with empirical human factors standards (ISO 9241-303, WCAG 1.4.12, Tullis display density models, and Rosenholtz visual clutter metrics). The interface remains fully readable when leaning back or stepping away from the screen, while reducing extraneous cognitive load during intense desktop work.

## Motivation

Avalon's current desktop interface exhibits extreme typographical compression and visual feature congestion:
1. **Sub-threshold type sizing**: Across `app.css`, multiple secondary metadata labels, tool execution summaries, timestamps, and badges are rendered at $8.5\text{px}$ to $11\text{px}$, with avatar fallbacks down to $6.5\text{px}$.
2. **Legibility collapse at physical distance**: At a standard viewing distance of $60\text{ cm}$ ($24\text{ in}$), $10\text{px}$ text subtends only $\approx 14.3\text{ arcminutes}$ of visual angle, violating the ISO 9241-303 minimum standard ($16\text{ arcmin}$) and the ergonomic comfort threshold ($20–22\text{ arcmin}$). When a user leans back or steps back 1 foot ($90\text{ cm} / 36\text{ in}$), the visual angle drops to $\approx 9.5\text{ arcmin}$, dropping below the critical print size (CPS) threshold and causing reading speeds to collapse.
3. **High local density and visual feature congestion**: Agent message actions, tool invocation details, context labels, and side rails are displayed simultaneously with tight vertical spacing ($18\text{px}–24\text{px}$ row heights). This high character density creates visual clutter (Rosenholtz Feature Congestion), inducing scanning fatigue and sensory overload.
4. **Lack of native zoom/density controls**: Users currently have no native keyboard-driven zoom (`Cmd +` / `Cmd -` / `Cmd 0`) or persisted density profile setting to adjust interface scale for varied monitor setups, eyesight requirements, or physical viewing distances.

## Goals

1. **Meet ISO 9241-303 and WCAG 1.4.12 visual standards**: Ensure all body text, conversational content, and interactive controls maintain a comfortable visual angle ($\ge 20\text{ arcminutes}$ at standard $60\text{ cm}$ viewing distance, with body text at $\ge 15\text{px}$ and line-height $\ge 1.5$).
2. **Eliminate sub-$12\text{px}$ metadata text**: Elevate secondary metadata, system messages, badges, and tool details to a minimum readable floor ($\ge 12\text{px}–13\text{px}$), deprecating sub-$11\text{px}$ microscopic type across the application.
3. **Constrain optimal reading measure**: Enforce a maximum line length of $65–75$ characters per line ($\approx 680\text{px}–760\text{px}$ max-width) for conversational transcripts and note details, preventing eye-tracking regression and scan fatigue.
4. **Implement progressive disclosure for dense agent activity**: Reduce Tullis local density and visual clutter by visually chunking agent tool executions, raw payload parameters, and system notes behind clean, collapsible disclosure containers with subtle visual boundaries.
5. **Introduce native UI zoom and density profiles**: Support standard keyboard shortcuts (`Cmd/Ctrl +`, `Cmd/Ctrl -`, `Cmd/Ctrl 0`) and provide a persistent density preference in Settings (Default, Comfortable, Compact) backed by CSS variables and Electron webFrame zoom APIs.

## Non-goals

1. **Complete visual redesign / re-theming**: Re-architecting Avalon's dark canvas theme palette (`#111210`, `#181916`, `#1d1e1b`) or altering fundamental navigation structures is out of scope.
2. **Dynamic per-element fluid typography**: Introducing complex viewport-dependent `clamp()` rules across arbitrary sub-components is rejected in favor of predictable root font-size scaling and standard density profiles.
3. **Custom font file bundling**: Avalon will continue using the high-legibility system stack (`Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`) rather than bundling third-party webfonts.
4. **Altering model response streaming contracts**: Modifying agent token streaming protocols or message payload structures is out of scope; all adjustments apply strictly to presentation layer rendering.

## Product behavior

### 1. Typography & Hierarchy System

| Role | Previous Size / Line Height | New Standard (Default) | Comfortable Profile |
| :--- | :--- | :--- | :--- |
| **Root / Base UI** | $14\text{px}$ / $1.48$ | $15\text{px}$ / $1.50$ | $16\text{px}$ / $1.55$ |
| **Body / Transcript / Notes** | $14\text{px}$ / $1.60$ | $15.5\text{px}$ / $1.60$ | $16.5\text{px}$ / $1.65$ |
| **Input / Composer** | $13\text{px}–14\text{px}$ | $15\text{px}$ / $1.50$ | $16\text{px}$ / $1.50$ |
| **Secondary / Rail / Tool Headers** | $10.5\text{px}–11.5\text{px}$ | $13\text{px}$ / $1.45$ | $14\text{px}$ / $1.50$ |
| **Captions / Timestamps / Badges** | $8.5\text{px}–10\text{px}$ | $12\text{px}$ / $1.40$ | $13\text{px}$ / $1.45$ |
| **Code / Tool Output Pre** | $10\text{px}–11.5\text{px}$ | $13\text{px}$ / $1.55$ | $14\text{px}$ / $1.60$ |

### 2. Reading Ergonomics & Transcript Sizing

* **Measure constraint**: Main transcript content blocks (`.markdown-body`, `.transcript-column`, `.meeting-notes-body`) constrain text blocks to an optimal measure of $55–75$ characters per line ($680\text{px}–760\text{px}$ content box), centering cleanly within available viewports without stretching edge-to-edge.
* **Paragraph & Block Spacing**: Inter-block spacing in transcripts increases from $14\text{px}$ to $18\text{px}–22\text{px}$, ensuring clear visual chunking between agent actions and human messages.

### 3. Progressive Disclosure & Clutter Reduction

* **Agent Tool Runs**: Multi-step agent tool executions render by default as compact, single-line structured cards with an icon, action label, and execution state badge ($13\text{px}$ text). Raw parameters, file diffs, and return payloads expand only on click/interaction.
* **System Messages & Timing**: Background run status lines and execution metrics collapse into unified footer status indicators rather than littering the main transcript with multiple raw text rows.
* **Contextual Right Rail**: Side rail sections (Participants, Attached Resources, Terminal Status) adopt generous $12\text{px}–16\text{px}$ padding and distinct surface contrast (`--surface` vs `--raised`) to eliminate claustrophobic metadata walls.

### 4. Density Preferences & Magnification

* **Settings Density Selector**: A dedicated **Appearance > Display Density** toggle in App Settings offering:
  * **Comfortable**: $105\%$ base scale, generous component padding ($10\text{px}–14\text{px}$), $16.5\text{px}$ transcript body. Ideal for larger 4K/5K displays and distance viewing.
  * **Default (Recommended)**: $100\%$ scale, balanced whitespace ($8\text{px}–12\text{px}$ padding), $15.5\text{px}$ transcript body.
  * **Compact**: $92\%$ scale, tighter padding ($4\text{px}–8\text{px}$), $14\text{px}$ transcript body. Designed for dense data tables and multi-window tiling.
* **Keyboard Magnification**: Electron webFrame zoom shortcuts (`Cmd/Ctrl +` to zoom in by $10\%$, `Cmd/Ctrl -` to zoom out by $10\%$, `Cmd/Ctrl 0` to reset to $100\%$) adjust the global application zoom factor smoothly from $80\%$ to $150\%$. The active zoom level is persisted across application restarts.

## Impact on the product contract

None — this refines visual presentation, layout spacing, and accessibility ergonomics within the existing application contract.

## Decision log

None yet.

## Key design decisions

1. **CSS Variable & rem token architecture over hardcoded pixels.**
   * *Decision:* Convert layout dimensions and font sizes to use relative typographic scale tokens (`--text-xs`, `--text-sm`, `--text-base`, `--text-lg`) defined at the root rather than arbitrary decimal pixel values (e.g., $9.5\text{px}$, $10.5\text{px}$).
   * *Alternative rejected:* Retaining hardcoded pixel values with ad-hoc overrides, which causes fragmentation and makes zoom/density themes unmaintainable.
2. **Native Electron webFrame zoom integration.**
   * *Decision:* Pair CSS token density themes with native Electron `webFrame.setZoomFactor()` for keyboard shortcuts.
   * *Alternative rejected:* Relying purely on CSS `transform: scale()`, which breaks fixed positioning, caret placement in textareas, and popover anchors.
3. **Progressive disclosure for agent tool activity.**
   * *Decision:* Default tool invocations to collapsed summary rows that expand on demand.
   * *Alternative rejected:* Permanently truncating or removing tool data (which destroys debuggability) or leaving all tool parameters expanded (which creates overwhelming visual clutter).

## Acceptance

1. **Typography Verification**: No production UI element in the desktop renderer renders text below $12\text{px}$ computed font size in Default mode.
2. **Distance & Visual Angle Compliance**: Base body text ($15.5\text{px}$) subtends $\ge 23.5\text{ arcminutes}$ at $60\text{ cm}$, and maintains $\ge 16\text{ arcminutes}$ when stepping back to $90\text{ cm}$ ($1\text{ foot}$ step-back).
3. **Zoom & Density Functionality**:
   * Switching between Compact, Default, and Comfortable in Settings updates all main surfaces immediately without layout breakage.
   * `Cmd +`, `Cmd -`, and `Cmd 0` adjust application scale smoothly and persist across window reload.
4. **Transcript Reading Experience**: Body text containers in work-stream conversations and notes enforce optimal line measure ($50–75\text{ CPL}$) and provide clean visual separation between message turns.
