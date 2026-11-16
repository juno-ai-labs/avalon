/**
 * The Marketplace's Canvas templates, read from the Markdown files beside
 * this module. The caller supplies the file reader, Node's `readFileSync` in
 * both build-time callers: the app's builds compile this into a virtual module
 * (`apps/desktop/canvas-template-plugin.ts`), and the public site renders its
 * `/marketplace/` page from the same list, so the two never disagree about
 * what the Marketplace offers. It lives here, beside the files, so a change to
 * the catalog is a change under `packages/`, which the site's deploy watches.
 */
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// By path rather than `@rally/contracts`: build configs run this in Node,
// which loads a bare package import unbundled and cannot resolve its
// extensionless imports.
import { PICKABLE_APPEARANCE_ICON_KEYS } from '../../contracts/src/appearance-icons';
import { templateLinkPath } from '../../contracts/src/links';
import { PALETTE_RING } from '../../contracts/src/palette';
import { describeZodIssues } from '../../contracts/src/zod-diagnostics';
import { CANVAS_TEMPLATE_CATEGORIES } from './categories';
import { TEMPLATE_CONNECTORS, TEMPLATE_PLUGINS } from './connectors';

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

export const CANVAS_TEMPLATE_ROOT = new URL('./', import.meta.url);

const templateMetadata = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  // The mark the template's card wears, from the catalog a Canvas's own
  // appearance picks from, so a card is drawn the way a Canvas is. Only the
  // card: a Canvas started from a template keeps its own generated mark.
  icon: z.enum(PICKABLE_APPEARANCE_ICON_KEYS),
  color: z.enum(PALETTE_RING),
  tags: z.array(z.enum(CANVAS_TEMPLATE_CATEGORIES.map(({ tag }) => tag))).min(1),
  // The connectors the template works best with, by `connectors.ts` id; the
  // public marketplace lists them on its card and page. None for a template
  // that needs no connected tool.
  connectors: z.array(z.enum(TEMPLATE_CONNECTORS.map(({ id }) => id))).default([]),
  // Rally's own plugins the template leans on, by `connectors.ts` id: built
  // in, so listed apart from what a person connects.
  plugins: z.array(z.enum(TEMPLATE_PLUGINS.map(({ id }) => id))).default([]),
});

/**
 * `slug` is the file's name without `.md`, and `link` the web app path that
 * starts it (`/app/templates/<slug>`, `templateLinkPath`), so a file is not
 * renamed lightly once its link has been handed out.
 */
export type CanvasTemplateData = z.infer<typeof templateMetadata> & { slug: string; link: string; prompt: string };

/** One template file: YAML front matter for its card, then the Markdown prompt it sends. */
export function parseCanvasTemplate(source: string, file: string): CanvasTemplateData {
  const document = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n([\s\S]*)$/u.exec(source);
  if (!document) throw new Error(`${file}: expected YAML frontmatter followed by a Markdown prompt.`);

  const metadata = templateMetadata.safeParse(parseYaml(document[1] ?? ''));
  if (!metadata.success) throw new Error(`${file}: invalid template frontmatter (${describeZodIssues(metadata.error)}).`);

  const prompt = document[2]?.trim();
  if (!prompt) throw new Error(`${file}: expected a nonempty Markdown prompt.`);

  const slug = file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/u, '');
  let link: string;
  try { link = templateLinkPath(slug); }
  catch { throw new Error(`${file}: a template's file name is lowercase words joined by hyphens.`); }
  return { ...metadata.data, slug, link, prompt };
}

/**
 * Every template, in catalog order, with `read` returning a file's text by its
 * URL. Read on each call so a dev server serves the current files.
 */
export function loadCanvasTemplates(read: (file: URL) => string): CanvasTemplateData[] {
  const templates = CANVAS_TEMPLATE_FILES.map((file) =>
    parseCanvasTemplate(read(new URL(file, CANVAS_TEMPLATE_ROOT)), file));
  const seen = new Set<string>();
  for (const { slug } of templates) {
    if (seen.has(slug)) throw new Error(`Two templates are named ${slug}.md; a template link needs each name once.`);
    seen.add(slug);
  }
  return templates;
}
