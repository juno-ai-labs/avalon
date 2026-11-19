/**
 * The Marketplace's categories, in the order every row of them is drawn. The
 * first is the one the Marketplace opens on.
 *
 * The audiences the public site has a page for come first, in the site's own
 * order (`apps/site/src/audiences.ts`): they are who Rally is sold to, and each
 * of those pages starts its category's first template.
 */
export const CANVAS_TEMPLATE_CATEGORIES = [
  { tag: 'wholesalers', label: 'Wholesalers' },
  { tag: 'agencies', label: 'Agencies' },
  { tag: 'legal', label: 'Legal teams' },
  { tag: 'accountants', label: 'Accountants' },
  { tag: 'recruiters', label: 'Recruiters' },
  { tag: 'brokers', label: 'Brokers' },
  { tag: 'event-planners', label: 'Event planners' },
  { tag: 'developers', label: 'Developers' },
  { tag: 'product-managers', label: 'Product managers' },
  { tag: 'parents', label: 'Parents' },
] as const;
