import {
  ArrowUp,
  AudioLines,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock,
  Copy,
  Ellipsis,
  ExternalLink,
  Globe2,
  GripVertical,
  LayoutDashboard,
  LoaderCircle,
  Lock,
  Mail,
  MessageSquare,
  Mic,
  Paperclip,
  Pencil,
  Plus,
  RefreshCcw,
  Search,
  Settings,
  Sparkles,
  Square,
  TowerControl,
  TriangleAlert,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';

import { cn } from './cn';

/**
 * Every icon the interface may draw, named for what it means.
 *
 * A name here is a *role*, not a picture: `dashboard`, not `LayoutDashboard`.
 * That is the whole point of the indirection. Before it, an author picked a
 * glyph straight out of whichever of the two icon packages came to mind — the
 * work-stream icon was Tabler's `IconAugmentedReality`, the meeting-notes
 * headings were `IconAirTrafficControl` and `IconWaveSine`, and the sidebar
 * drew its overflow and lock marks from Tabler while five other files drew the
 * same two marks from Lucide. Nothing was wrong at any one call site and the
 * set as a whole was incoherent, because no call site could see the set.
 *
 * Adding a row is how the set grows. Reaching past it for a glyph is not: the
 * `rally/icon-registry` ESLint rule fails a `lucide-react` import anywhere but
 * this file.
 */
const icons = {
  add: Plus,
  attachment: Paperclip,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  check: Check,
  clock: Clock,
  close: X,
  copy: Copy,
  'control-tower': TowerControl,
  dashboard: LayoutDashboard,
  'drag-handle': GripVertical,
  edit: Pencil,
  error: CircleAlert,
  'external-link': ExternalLink,
  mail: Mail,
  message: MessageSquare,
  microphone: Mic,
  more: Ellipsis,
  private: Lock,
  refresh: RefreshCcw,
  region: Globe2,
  search: Search,
  send: ArrowUp,
  settings: Settings,
  spinner: LoaderCircle,
  suggestion: Sparkles,
  stop: Square,
  trash: Trash2,
  warning: TriangleAlert,
  waveform: AudioLines,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof icons;

/** Sorted, so the explorer and the tests iterate in a stable order. */
export const iconNames = Object.keys(icons).sort() as IconName[];

/**
 * Four sizes, because thirteen was the alternative.
 *
 * The renderer drew icons at 9, 10, 12, 13, 14, 15, 16, 17, 18, 20, 22 and 24
 * pixels and at five different stroke widths, all of it per call site. No two
 * of those steps are distinguishable side by side, and the drift is invisible
 * in review because each number looks reasonable next to the one line that
 * chose it. A closed scale makes the question "which size" answerable.
 */
const sizes = {
  /** Inline with `text-hint` — a badge, a chip, a trailing chevron. */
  xs: 12,
  /** The default. Inline with body text, and what a row's leading mark uses. */
  sm: 14,
  /** A control's own icon: buttons, menu items, the composer's actions. */
  md: 16,
  /** A section heading, or an icon standing alone as the subject of a tile. */
  lg: 20,
} as const;

export type IconSize = keyof typeof sizes;

export interface IconProps {
  name: IconName;
  size?: IconSize;
  className?: string;
  /**
   * The accessible name, when the icon is the only thing carrying it — a
   * control with no visible label. Omit it and the icon is `aria-hidden`,
   * which is right wherever text beside it already says the same thing.
   */
  label?: string;
  /**
   * Rotates the icon. It takes `app.css`'s `.spin` rather than Tailwind's
   * `animate-spin` so a migrated spinner keeps turning at the 0.8s the other
   * forty-seven in the renderer do — two spin speeds beside each other read as
   * one of them being stuck.
   */
  spinning?: boolean;
}

export function Icon({ name, size = 'sm', className, label, spinning }: IconProps): React.JSX.Element {
  const Glyph = icons[name];
  return (
    <Glyph
      className={cn(spinning && 'spin', className)}
      size={sizes[size]}
      strokeWidth={2}
      {...(label === undefined
        ? { 'aria-hidden': true }
        : { 'aria-label': label, role: 'img' })}
    />
  );
}
