/**
 * The person's iOS text size (Dynamic Type) for the touch density.
 *
 * WebKit resolves `font: -apple-system-body` and its siblings to the sizes the
 * person chose in Settings > Display & Text Size. CSS cannot read a size back
 * out of a `font` keyword, so the host measures each style on a hidden probe
 * and hands the sizes to the touch density through `--av-dynamic-type-<role>`,
 * which every touch role reads before its design value
 * (`config/design-tokens/densities/touch.json`). The design values themselves
 * are read back from the stylesheet rather than repeated here.
 *
 * iOS does not grow every style by the same factor, so a role with its own
 * keyword is measured directly; one without (callout, the large titles) moves
 * with body. Outside WebKit the keywords are unsupported and nothing is set.
 */

/** The type roles, smallest first. The sizes live in the design tokens. */
export const TYPE_ROLES = ['caption-2', 'caption-1', 'footnote', 'subheadline', 'callout', 'body', 'headline', 'title-3', 'title-2', 'title-1', 'large-title', 'display'] as const;
export type TypeRole = (typeof TYPE_ROLES)[number];

/** WebKit's font keyword for each role that iOS has a text style for. */
const KEYWORDS: Partial<Record<TypeRole, string>> = {
  'caption-2': '-apple-system-caption2',
  'caption-1': '-apple-system-caption1',
  footnote: '-apple-system-footnote',
  subheadline: '-apple-system-subheadline',
  body: '-apple-system-body',
  headline: '-apple-system-headline',
  'title-3': '-apple-system-title3',
  'title-2': '-apple-system-title2',
  'title-1': '-apple-system-title1',
};

/**
 * The size of each role under the person's setting, in px, or null when body
 * cannot be measured. `measure` returns a keyword's size, or null when the
 * engine does not support that keyword.
 */
export function dynamicTypeSizes(defaults: Record<TypeRole, number>, measure: (keyword: string) => number | null): Record<TypeRole, number> | null {
  const body = measure(KEYWORDS.body!);
  if (!body || !defaults.body) return null;
  const ratio = body / defaults.body;
  const sizes = {} as Record<TypeRole, number>;
  for (const role of TYPE_ROLES) {
    const keyword = KEYWORDS[role];
    const measured = keyword ? measure(keyword) : null;
    sizes[role] = Math.round((measured ?? defaults[role] * ratio) * 2) / 2;
  }
  return sizes;
}

/**
 * Measures on a hidden probe and touches `root` only for a value
 * that changed, so a return to the foreground with the same text size, nearly
 * every one, restyles nothing but the probe. The probe resets the host's
 * variables on itself with `initial`, which makes a custom property invalid, so
 * its touch roles fall back to their design values without clearing `root`.
 */
function apply(root: HTMLElement): void {
  const probe = document.createElement('span');
  probe.dataset.density = 'touch';
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  for (const role of TYPE_ROLES) probe.style.setProperty(`--av-dynamic-type-${role}`, 'initial');
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
    for (const role of TYPE_ROLES) {
      const name = `--av-dynamic-type-${role}`;
      const value = `${sizes[role]}px`;
      if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
    }
  } finally {
    probe.remove();
  }
}

/**
 * Sets the touch roles from the person's text size, and again whenever the app
 * returns to the foreground, which is when a change made in Settings can have
 * happened. Returns the cleanup.
 */
export function installDynamicType(root: HTMLElement = document.documentElement): () => void {
  if (typeof CSS === 'undefined' || !CSS.supports('font', KEYWORDS.body!)) return () => undefined;
  apply(root);
  const onVisibility = (): void => { if (document.visibilityState === 'visible') apply(root); };
  document.addEventListener('visibilitychange', onVisibility);
  return () => document.removeEventListener('visibilitychange', onVisibility);
}
