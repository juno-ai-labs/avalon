/**
 * The person's iOS text size (Dynamic Type) for the touch density.
 *
 * WebKit resolves `font: -apple-system-body` and its siblings to the sizes the
 * person chose in Settings > Display & Text Size. CSS cannot read a size back
 * out of a `font` keyword, so the host measures each style on a hidden probe
 * and writes the sizes over the touch roles, `--av-sys-type-<role>`, inline on
 * `<html>`. An inline declaration beats the `[data-density='touch']` block on
 * the same element, every alias of a role resolves against it there, and a
 * subtree marked `data-density="default"` re-declares its own values, so
 * artifacts keep their document sizes. The design values are read back from the
 * stylesheet on the probe, which carries the density itself.
 *
 * iOS does not grow every style by the same factor, so a role with its own
 * keyword is measured directly. Callout moves with body; large title and
 * display, which have no keyword, move with title 1, the largest style that
 * has one, because iOS grows its titles far less than its body text. Outside iOS
 * nothing is set: other engines lack the keywords, and macOS WebKit resolves
 * them to the Mac's sizes rather than Dynamic Type.
 */
import { TYPE_SCALE_CHANGED_EVENT } from '@rally/ui/lib/theme';

/** The type roles, smallest first. The sizes live in the design tokens. */
const TYPE_ROLES = ['caption-2', 'caption-1', 'footnote', 'subheadline', 'callout', 'body', 'headline', 'title-3', 'title-2', 'title-1', 'large-title', 'display'] as const;
type TypeRole = (typeof TYPE_ROLES)[number];

/** WebKit's font keyword for each role that iOS has a text style for. */
const KEYWORDS = {
  'caption-2': '-apple-system-caption2',
  'caption-1': '-apple-system-caption1',
  footnote: '-apple-system-footnote',
  subheadline: '-apple-system-subheadline',
  body: '-apple-system-body',
  headline: '-apple-system-headline',
  'title-3': '-apple-system-title3',
  'title-2': '-apple-system-title2',
  'title-1': '-apple-system-title1',
} satisfies Partial<Record<TypeRole, string>>;

/** The measured role a role without a keyword moves with. */
const FOLLOWS: Record<Exclude<TypeRole, keyof typeof KEYWORDS>, keyof typeof KEYWORDS> = {
  callout: 'body',
  'large-title': 'title-1',
  display: 'title-1',
};

/** Whether this engine's `-apple-system-*` keywords mean Dynamic Type: iOS, including an iPad that reports itself as a touch Mac. */
export function isDynamicTypeHost(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return /iP(?:hone|ad|od)/u.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
}

/**
 * The size of each role under the person's setting, in px, or null when body
 * cannot be measured or a design value cannot be read. `measure` returns a
 * keyword's size, or null when it cannot.
 */
export function dynamicTypeSizes(defaults: Record<TypeRole, number>, measure: (keyword: string) => number | null): Record<TypeRole, number> | null {
  if (!TYPE_ROLES.every((role) => Number.isFinite(defaults[role]) && defaults[role] > 0)) return null;
  const measured: Partial<Record<TypeRole, number>> = {};
  for (const [role, keyword] of Object.entries(KEYWORDS) as [keyof typeof KEYWORDS, string][]) {
    const size = measure(keyword);
    if (size !== null) measured[role] = size;
  }
  if (measured.body === undefined) return null;
  const sizes = {} as Record<TypeRole, number>;
  for (const role of TYPE_ROLES) {
    const anchor = role in FOLLOWS ? FOLLOWS[role as keyof typeof FOLLOWS] : (role as keyof typeof KEYWORDS);
    const scaled = measured[anchor] === undefined ? defaults[role] * (measured.body / defaults.body) : defaults[role] * (measured[anchor] / defaults[anchor]);
    sizes[role] = Math.round((role in FOLLOWS ? scaled : measured[role] ?? scaled) * 2) / 2;
  }
  return sizes;
}

/** The inline writes that bring `current` to `sizes`: only the roles whose value differs. */
export function typeScaleWrites(current: (name: string) => string, sizes: Record<TypeRole, number>): [string, string][] {
  return TYPE_ROLES.map((role): [string, string] => [`--av-sys-type-${role}`, `${sizes[role]}px`]).filter(([name, value]) => current(name) !== value);
}

/**
 * Measures on a hidden probe and writes `root` only for a value that changed,
 * so a return to the foreground with the same text size, nearly every one,
 * restyles nothing but the probe. A change is announced so a field that sized
 * itself to its text, such as the composer, can measure again.
 */
function apply(root: HTMLElement): void {
  const probe = document.createElement('span');
  probe.dataset.density = 'touch';
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  try {
    const computed = getComputedStyle(probe);
    const defaults = Object.fromEntries(TYPE_ROLES.map((role) => [role, Number.parseFloat(computed.getPropertyValue(`--av-sys-type-${role}`))])) as Record<TypeRole, number>;
    const measure = (keyword: string): number | null => {
      // An unsupported keyword leaves `font` as it was, which would measure the
      // previous style again.
      if (!CSS.supports('font', keyword)) return null;
      probe.style.removeProperty('font');
      probe.style.font = keyword;
      const size = Number.parseFloat(getComputedStyle(probe).fontSize);
      return Number.isFinite(size) && size > 0 ? size : null;
    };
    const sizes = dynamicTypeSizes(defaults, measure);
    if (!sizes) return;
    const writes = typeScaleWrites((name) => root.style.getPropertyValue(name), sizes);
    for (const [name, value] of writes) root.style.setProperty(name, value);
    if (writes.length) window.dispatchEvent(new Event(TYPE_SCALE_CHANGED_EVENT));
  } finally {
    probe.remove();
  }
}

/**
 * Sets the touch roles from the person's text size, and again whenever the app
 * returns to the foreground, which is when a change made in Settings can have
 * happened. A no-op outside iOS.
 */
export function installDynamicType(root: HTMLElement = document.documentElement): void {
  if (!isDynamicTypeHost(navigator.userAgent, navigator.platform, navigator.maxTouchPoints)) return;
  if (typeof CSS === 'undefined' || !CSS.supports('font', KEYWORDS.body)) return;
  apply(root);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') apply(root); });
}
