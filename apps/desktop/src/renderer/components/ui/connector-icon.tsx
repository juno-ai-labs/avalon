import type { AutomationPluginIcon } from '@rally/contracts';
import {
  IconBrandGithub,
  IconBrandGoogle,
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconBrandSlack,
  IconPlug,
  IconStack2,
  IconWebhook,
  IconWorldSearch,
  type TablerIcon,
} from '@tabler/icons-react';

import { cn } from './cn';

/**
 * The brand marks, which is the one job Tabler keeps.
 *
 * Lucide removed its brand icons in 2023 over trademark exposure, so a product
 * that shows a GitHub mark beside a GitHub connector needs a second source or a
 * hand-drawn set. That is a real reason for a second package and it is the only
 * one: every Tabler glyph the renderer drew that was *not* a brand mark is a
 * row in `icon.tsx` now. The `rally/icon-registry` ESLint rule holds the line —
 * `@tabler/icons-react` imports nowhere but here.
 */
const marks: Record<AutomationPluginIcon, TablerIcon> = {
  'brand-github': IconBrandGithub,
  'brand-google': IconBrandGoogle,
  'brand-google-drive': IconBrandGoogleDrive,
  'brand-notion': IconBrandNotion,
  'brand-slack': IconBrandSlack,
  linear: IconStack2,
  plug: IconPlug,
  webhook: IconWebhook,
  'world-search': IconWorldSearch,
};

export const connectorNames = Object.keys(marks).sort() as AutomationPluginIcon[];

/**
 * The face a connector wears. `cmp.connector.*` gives each one a background and
 * a foreground per theme, which is why this is a component rather than an icon
 * with a class beside it: the two halves have to be chosen together or the mark
 * disappears into its own tile.
 */
const faces: Record<AutomationPluginIcon, string> = {
  'brand-github': 'bg-connector-github-background text-connector-github-foreground',
  'brand-google': 'bg-connector-google-background text-connector-google-foreground',
  'brand-google-drive': 'bg-connector-drive-background text-connector-drive-foreground',
  // Notion has no connector tokens: its mark is monochrome, so it keeps the
  // tile's own surface and only lifts its ink.
  'brand-notion': 'text-ink-subtle',
  'brand-slack': 'bg-connector-slack-background text-connector-slack-foreground',
  linear: 'bg-connector-linear-background text-connector-linear-foreground',
  plug: 'bg-connector-plug-background text-connector-plug-foreground',
  webhook: 'bg-connector-webhook-background text-connector-webhook-foreground',
  'world-search': 'bg-connector-search-background text-connector-search-foreground',
};

export interface ConnectorIconProps {
  name: AutomationPluginIcon;
  /**
   * The connector's own name — `Slack`, not `brand-slack`. Omit it where the
   * row around the mark already carries the name, and the mark is hidden from
   * assistive technology rather than announced twice.
   */
  label?: string;
  /**
   * The hover title, when it differs from the accessible name. A tool row
   * names the mark `Plugin: Slack` for a screen reader, because the row's other
   * children are already announcing tool names, and `Slack` on hover, because
   * a tooltip repeating the word "Plugin" on every row is noise.
   */
  title?: string;
  /** The bare mark, with no tile behind it. */
  plain?: boolean;
  className?: string;
}

export function ConnectorIcon({ name, label, title, plain, className }: ConnectorIconProps): React.JSX.Element {
  const Mark = marks[name];
  const naming = label === undefined ? { 'aria-hidden': true } : { 'aria-label': label, role: 'img' as const };
  if (plain) return <Mark className={cn('shrink-0', className)} size={13} stroke={1.8} {...naming} />;
  return (
    <span
      {...naming}
      className={cn(
        // `border-line-subtle` is `ref.color.line.1`, which is what the
        // `.plugin-face` rule this replaces named directly. Reaching for the
        // ramp step was the rule's own shortcut past the semantic layer; the
        // pixels are identical and the name now says which of the three
        // borders it is.
        'relative inline-flex h-6 w-6 shrink-0 items-center justify-center',
        'rounded-pill border-2 border-line-subtle bg-surface-raised-hover text-ink-muted',
        faces[name],
        className,
      )}
      title={title ?? label}
    >
      <Mark aria-hidden="true" size={14} stroke={1.8} />
    </span>
  );
}
