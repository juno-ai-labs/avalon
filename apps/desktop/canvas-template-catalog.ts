/**
 * The Marketplace's Canvas templates, read from the Markdown files in
 * `packages/skills/marketplace-skills/`. Node only: the app's builds compile
 * this into a virtual module (`canvas-template-plugin.ts`), and the public
 * site renders its `/marketplace/` page from the same list, so the two never
 * disagree about what the Marketplace offers.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { PICKABLE_APPEARANCE_ICON_KEYS } from '../../packages/contracts/src/appearance-icons';
import { PALETTE_RING } from '../../packages/contracts/src/palette';
import { describeZodIssues } from '../../packages/contracts/src/zod-diagnostics';
import { CANVAS_TEMPLATE_CATEGORIES } from './src/renderer/lib/canvas-template-categories';

/**
 * The catalog in order, relative to `marketplace-skills/`. The first template
 * of each category is what an empty Canvas shows under Popular.
 */
export const CANVAS_TEMPLATE_FILES = [
  'developers/pr-dashboard.md',
  'developers/email-notification-screener.md',
  'developers/repository-changes-podcast.md',
  'product-managers/granola-feature-requests.md',
  'product-managers/competitor-change-monitor.md',
  'parents/school-notifications-and-calendar.md',
  'parents/shared-grocery-list.md',
  'parents/family-calendar-feed.md',
  'recruiters/recruiting-market-map.md',
] as const;

export const CANVAS_TEMPLATE_ROOT = new URL('../../packages/skills/marketplace-skills/', import.meta.url);

const templateMetadata = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  // The mark the template's card wears, from the catalog a Canvas's own
  // appearance picks from, so a card is drawn the way a Canvas is. Only the
  // card: a Canvas started from a template keeps its own generated mark.
  icon: z.enum(PICKABLE_APPEARANCE_ICON_KEYS),
  color: z.enum(PALETTE_RING),
  tags: z.array(z.enum(CANVAS_TEMPLATE_CATEGORIES.map(({ tag }) => tag))).min(1),
});

export type CanvasTemplateData = z.infer<typeof templateMetadata> & { prompt: string };

/** One template file: YAML front matter for its card, then the Markdown prompt it sends. */
export function parseCanvasTemplate(source: string, file: string): CanvasTemplateData {
  const document = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n([\s\S]*)$/u.exec(source);
  if (!document) throw new Error(`${file}: expected YAML frontmatter followed by a Markdown prompt.`);

  const metadata = templateMetadata.safeParse(parseYaml(document[1] ?? ''));
  if (!metadata.success) throw new Error(`${file}: invalid template frontmatter (${describeZodIssues(metadata.error)}).`);

  const prompt = document[2]?.trim();
  if (!prompt) throw new Error(`${file}: expected a nonempty Markdown prompt.`);

  return { ...metadata.data, prompt };
}

/** Every template, in catalog order. Read on each call so a dev server serves the current files. */
export function loadCanvasTemplates(): CanvasTemplateData[] {
  return CANVAS_TEMPLATE_FILES.map((file) =>
    parseCanvasTemplate(readFileSync(new URL(file, CANVAS_TEMPLATE_ROOT), 'utf8'), file));
}
