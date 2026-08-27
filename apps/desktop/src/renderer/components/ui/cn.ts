import clsx, { type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

import {
  borderRadius,
  borderWidth,
  boxShadow,
  fontFamily,
  fontSize,
  fontWeight,
  lineHeight,
} from '../../styles/tailwind-theme';

/**
 * `tailwind-merge` has to be told about the scales that are ours, because it
 * classifies an unknown `text-*` by shape and every one of our names has the
 * shape of a colour.
 *
 * `text-hint` is a font size and `text-ink-muted` is a colour; to the stock
 * configuration both are `text-color`, so `cn('text-hint', 'text-ink-muted')`
 * drops the size and the type comes out at whatever it inherited. The failure
 * is silent, it only appears where two classes actually meet — which is exactly
 * what `cn` is for — and it looks like a bug in the component. `font-ui` versus
 * `font-strong` and `border-hairline` versus `border-line` are the same
 * collision.
 *
 * The keys come from the generated module rather than a list written here, so
 * a token added to `config/design-tokens/registry.json` is classified correctly
 * without anyone remembering this file exists.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: Object.keys(fontSize) }],
      'font-weight': [{ font: Object.keys(fontWeight) }],
      'font-family': [{ font: Object.keys(fontFamily) }],
      leading: [{ leading: Object.keys(lineHeight) }],
      shadow: [{ shadow: Object.keys(boxShadow) }],
      rounded: [{ rounded: Object.keys(borderRadius) }],
      'border-w': [{ border: Object.keys(borderWidth) }],
    },
  },
});

/**
 * Compose class names, letting a later one win over an earlier one.
 *
 * Every primitive in `components/ui/` ends with `cn(variants(...), className)`,
 * which is what makes a caller's `className` an override rather than a second
 * declaration racing the first on source order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
