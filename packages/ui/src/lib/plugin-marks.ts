import Apple from '@thesvg/react/apple';
import Canva from './brand-marks/canva';
import Cloudflare from '@thesvg/react/cloudflare';
import Github from '@thesvg/react/github';
import Google from '@thesvg/react/google';
import GoogleDrive from '@thesvg/react/google-drive';
import Granola from '@thesvg/react/granola';
import Linear from '@thesvg/react/linear';
import ModelContextProtocol from '@thesvg/react/model-context-protocol';
import Notion from '@thesvg/react/notion';
import Slack from '@thesvg/react/slack';
import X from '@thesvg/react/x';
import type { ComponentType } from 'react';
import Ashby from './brand-marks/ashby';
import Apollo from './brand-marks/apollo';
import Fireflies from './brand-marks/fireflies';

/**
 * A company's own mark, as a React component.
 *
 * Imported one brand per subpath — `@thesvg/react/github`, never
 * `import { Github } from '@thesvg/react'`. The barrel is not a style
 * preference: `@thesvg/icons`' per-icon declaration imports a type from its own
 * index, so a single icon pulls all ~6,500 of them into the TypeScript program.
 * That took the desktop renderer's program from 575 files to 7,095 and made a
 * cold `pnpm lint` run out of heap on CI. The `@thesvg/react` subpath
 * declarations import only from `react`, so they cost what they look like.
 * `scripts/eslint-rules/thesvg-subpath-imports.mjs` enforces it, and
 * `docs/using-company-brand-icons.md` is the note.
 *
 * Every mark is drawn in `currentColor`: the package's `mono` variant already
 * is, and `.connector-mark` recolours the brands that ship no `mono` — see the
 * rule beside it. That is what this feed wants, one contrasting neutral across
 * both appearances, rather than separate brand palettes that can disappear
 * against one ground or the other.
 */
/**
 * One brand's component, and whether it has single-colour art to ask for.
 *
 * Ten of the twelve ship a `mono` variant, which paints in `currentColor`.
 * Slack and Granola ship none — their variant unions are `default | wordmark`
 * and `default | light | dark` — so asking for `mono` there is a type error
 * rather than a silent fallback, and `.connector-mark` recolours their palette
 * in CSS instead. Encoding that here keeps the fact checkable: a brand that
 * gains or loses `mono` upstream fails this table rather than the render.
 * Ashby and Fireflies are not in `@thesvg/react`; their local components only
 * ship the monochrome art, which is why they sit in the `mono: true` branch.
 */
export type PluginBrandMarkComponent =
  | { readonly Mark: ComponentType<{ className?: string; variant?: 'mono' }>; readonly mono: true }
  | { readonly Mark: ComponentType<{ className?: string }>; readonly mono: false };

/**
 * The brands Rally connects to, or links out to, that have a mark of their own.
 * `model-context-protocol` is the protocol's mark rather than a company's: it
 * is what a custom MCP server wears when its name spells out no company here.
 */
export const PLUGIN_BRAND_MARKS: Record<
  'apollo' | 'apple' | 'ashby' | 'canva' | 'cloudflare' | 'fireflies' | 'github' | 'google' | 'google-drive' | 'granola' | 'linear' | 'model-context-protocol' | 'notion' | 'slack' | 'x',
  PluginBrandMarkComponent
> = {
  apollo: { Mark: Apollo, mono: true },
  apple: { Mark: Apple, mono: true },
  canva: { Mark: Canva, mono: true },
  cloudflare: { Mark: Cloudflare, mono: true },
  ashby: { Mark: Ashby, mono: true },
  fireflies: { Mark: Fireflies, mono: true },
  github: { Mark: Github, mono: true },
  google: { Mark: Google, mono: true },
  'google-drive': { Mark: GoogleDrive, mono: true },
  granola: { Mark: Granola, mono: false },
  linear: { Mark: Linear, mono: true },
  'model-context-protocol': { Mark: ModelContextProtocol, mono: true },
  notion: { Mark: Notion, mono: true },
  slack: { Mark: Slack, mono: false },
  x: { Mark: X, mono: true },
};

export type PluginBrandMark = keyof typeof PLUGIN_BRAND_MARKS;

/**
 * Whether a glyph name is a company's mark rather than one of the shapes no
 * company owns. A guard rather than a bare `in`, so the narrowing is real: what
 * is left after it stays a closed union, and a glyph added to one table but not
 * the other fails to typecheck instead of rendering as undefined.
 */
export function isPluginBrandMark(icon: string): icon is PluginBrandMark {
  return icon in PLUGIN_BRAND_MARKS;
}

/**
 * The mark a connector wears, from the type its own manifest declares.
 *
 * This is the mapping every surface goes through, so a connector wears one mark
 * in Settings, in the transcript, and anywhere else it is drawn — the alternative
 * is what was here before, where the same company was a `GitBranch` on one
 * screen and a `brand-github` on another.
 *
 * Google is the one type that is two brands: a Gmail and Calendar connection and
 * a Drive connection share the type and are told apart by their name, which is
 * the same discriminator the backend uses.
 *
 * Null is not a failure. A webhook is not a company and has no mark to wear, and
 * a connector added before this mapping learns about it draws the generic plug.
 * A custom MCP server is never null: one whose name spells out no company here
 * wears the protocol's own mark.
 */
export function connectorBrandMark(
  connectorType: string,
  displayName?: string,
): PluginBrandMark | null {
  switch (connectorType) {
    case 'apollo': return 'apollo';
    case 'ashby': return 'ashby';
    case 'canva': return 'canva';
    case 'fireflies': return 'fireflies';
    case 'github': return 'github';
    case 'google': return displayName?.includes('Drive') ? 'google-drive' : 'google';
    case 'granola': return 'granola';
    case 'linear': return 'linear';
    case 'notion': return 'notion';
    case 'slack': return 'slack';
    case 'x': return 'x';
    case 'custom_mcp': return (displayName ? markNamedIn(displayName) : null) ?? 'model-context-protocol';
    default: return null;
  }
}

/**
 * The company a custom MCP server's own name spells out, as whole words.
 *
 * A custom server has no connector type of its own to key on, and the list
 * Settings draws from carries only the name its creator gave it — "Cloudflare
 * API", "Linear (staging)". Whole words, longest first, so "Google Drive" is
 * Drive and "Ex" or "Next" never reads as X. `x`, `apple` and `apollo` are left out:
 * those words alone cannot identify a company (Apollo may mean Apollo GraphQL).
 * The protocol's own mark is the fallback, not a name to match.
 */
const namedMarks = (Object.keys(PLUGIN_BRAND_MARKS) as PluginBrandMark[])
  .filter((mark) => mark !== 'x' && mark !== 'apple' && mark !== 'apollo' && mark !== 'model-context-protocol')
  .sort((a, b) => b.length - a.length);
function markNamedIn(displayName: string): PluginBrandMark | null {
  const words = ` ${displayName.toLowerCase().split(/[^a-z0-9]+/u).join(' ')} `;
  return namedMarks.find((mark) => words.includes(` ${mark.replace('-', ' ')} `)) ?? null;
}
