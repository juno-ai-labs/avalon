import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';

// The help center's source is a folder of Markdown files, two levels deep:
//
//   help/index.md                    -> /help/
//   help/01-getting-started/index.md -> /help/getting-started/        (chapter intro)
//   help/01-getting-started/02-x.md  -> /help/getting-started/x/      (page)
//
// The numeric prefix sets the order and is dropped from the URL, so the folder
// listing is the table of contents. Anything that is not Markdown (images,
// diagrams) may sit anywhere and is published only when a page references it.

export interface HelpFrontMatter {
  title: string;
  description: string;
  /** Shorter label for the sidebar when the title is long. */
  navTitle?: string;
  /** Drafts render in `vite dev` and are left out of the build. */
  draft?: boolean;
}

export type HelpPageKind = 'home' | 'chapter' | 'page';

export interface HelpPage {
  kind: HelpPageKind;
  /** Absolute path of the Markdown source. */
  sourcePath: string;
  /** Path relative to the content root, for messages. */
  sourceName: string;
  /** Canonical URL path, always with a trailing slash. */
  url: string;
  /** URL path of the raw Markdown copy. */
  markdownUrl: string;
  frontMatter: HelpFrontMatter;
  body: string;
  /** Set for chapter intros and pages. */
  chapter?: HelpChapter;
}

export interface HelpChapter {
  /** Position in the manual, counted from one. */
  number: number;
  slug: string;
  intro: HelpPage;
  pages: HelpPage[];
}

export interface HelpSite {
  root: string;
  home: HelpPage;
  chapters: HelpChapter[];
  /** Every page in reading order: home, then each chapter intro and its pages. */
  pages: HelpPage[];
}

export class HelpContentError extends Error {
  constructor(readonly problems: string[]) {
    super(`The help center has ${problems.length} problem(s):\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'HelpContentError';
  }
}

const ORDERED_NAME = /^(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)$/u;

/** "03-sidekicks" -> { order: 3, slug: "sidekicks" }. */
function orderedName(name: string): { order: number; slug: string } | undefined {
  const match = ORDERED_NAME.exec(name);
  return match?.[1] && match[2] ? { order: Number(match[1]), slug: match[2] } : undefined;
}
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u;
const KNOWN_KEYS = new Set(['title', 'description', 'nav_title', 'draft']);

export function parseFrontMatter(source: string, name: string, problems: string[]): { frontMatter: HelpFrontMatter; body: string } {
  const match = FRONT_MATTER.exec(source);
  if (!match) {
    problems.push(`${name}: missing front matter (start the file with ---, title:, description:, ---)`);
    return { frontMatter: { title: name, description: '' }, body: source };
  }
  let data: unknown;
  try {
    data = parseYaml(match[1] ?? '');
  } catch (error) {
    problems.push(`${name}: front matter is not valid YAML (${(error as Error).message.split('\n')[0]})`);
    data = {};
  }
  const fields = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!KNOWN_KEYS.has(key)) problems.push(`${name}: unknown front matter key "${key}" (allowed: ${[...KNOWN_KEYS].join(', ')})`);
  }
  const text = (key: string, required: boolean): string | undefined => {
    const value = fields[key];
    if (value === undefined || value === null) {
      if (required) problems.push(`${name}: front matter needs "${key}"`);
      return undefined;
    }
    if (typeof value !== 'string' || !value.trim()) {
      problems.push(`${name}: "${key}" must be non-empty text`);
      return undefined;
    }
    return value.trim();
  };
  const draft = fields.draft;
  if (draft !== undefined && typeof draft !== 'boolean') problems.push(`${name}: "draft" must be true or false`);
  const frontMatter: HelpFrontMatter = {
    title: text('title', true) ?? name,
    description: text('description', true) ?? '',
  };
  const navTitle = text('nav_title', false);
  if (navTitle) frontMatter.navTitle = navTitle;
  if (draft === true) frontMatter.draft = true;
  return { frontMatter, body: source.slice(match[0].length) };
}

function readPage(root: string, path: string, kind: HelpPageKind, url: string, problems: string[]): HelpPage {
  const sourceName = relative(root, path);
  const { frontMatter, body } = parseFrontMatter(readFileSync(path, 'utf8'), sourceName, problems);
  const markdownUrl = url === '/help/' ? '/help/index.md' : `${url.slice(0, -1)}.md`;
  return { kind, sourcePath: path, sourceName, url, markdownUrl, frontMatter, body };
}

function containsMarkdown(dir: string): boolean {
  return readdirSync(dir, { withFileTypes: true }).some((entry) =>
    entry.isDirectory() ? containsMarkdown(join(dir, entry.name)) : entry.name.endsWith('.md'));
}

/**
 * Reads the content tree. Every problem is collected and thrown together, so
 * one build names everything an author has to fix.
 */
export function loadHelpSite(root: string, options: { includeDrafts?: boolean | undefined } = {}): HelpSite {
  const problems: string[] = [];
  const visible = (page: HelpPage): boolean => options.includeDrafts === true || page.frontMatter.draft !== true;
  const homePath = join(root, 'index.md');
  let home: HelpPage | undefined;
  try {
    statSync(homePath);
    home = readPage(root, homePath, 'home', '/help/', problems);
  } catch {
    problems.push('index.md: the help center needs a home page at its root');
  }

  const chapters: HelpChapter[] = [];
  const chapterSlugs = new Map<string, string>();
  const chapterNumbers = new Map<number, string>();
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    if (entry.isFile()) {
      if (entry.name.endsWith('.md') && entry.name !== 'index.md' && entry.name !== 'README.md') {
        problems.push(`${entry.name}: pages live inside a chapter folder, not at the root`);
      }
      continue;
    }
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const named = orderedName(entry.name);
    if (!named) {
      if (containsMarkdown(dir)) problems.push(`${entry.name}/: chapter folders are named NN-slug, e.g. 03-sidekicks`);
      continue;
    }
    const { order: number, slug } = named;
    if (chapterSlugs.has(slug)) problems.push(`${entry.name}/: slug "${slug}" is also used by ${chapterSlugs.get(slug)}/`);
    if (chapterNumbers.has(number)) problems.push(`${entry.name}/: number ${number} is also used by ${chapterNumbers.get(number)}/`);
    chapterSlugs.set(slug, entry.name);
    chapterNumbers.set(number, entry.name);

    const introPath = join(dir, 'index.md');
    let intro: HelpPage;
    try {
      statSync(introPath);
      intro = readPage(root, introPath, 'chapter', `/help/${slug}/`, problems);
    } catch {
      problems.push(`${entry.name}/: every chapter needs an index.md introduction`);
      continue;
    }
    const chapter: HelpChapter = { number, slug, intro, pages: [] };
    const pageOrder = new Map<HelpPage, number>();
    intro.chapter = chapter;

    const pageSlugs = new Map<string, string>();
    const pageEntries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const pageEntry of pageEntries) {
      const where = `${entry.name}/${pageEntry.name}`;
      if (pageEntry.isDirectory()) {
        if (containsMarkdown(join(dir, pageEntry.name))) {
          problems.push(`${where}/: chapters are one level deep; nested folders may hold images but not pages`);
        }
        continue;
      }
      if (!pageEntry.name.endsWith('.md') || pageEntry.name === 'index.md') continue;
      const pageNamed = orderedName(pageEntry.name.slice(0, -3));
      if (!pageNamed) {
        problems.push(`${where}: page files are named NN-slug.md, e.g. 02-invite-people.md`);
        continue;
      }
      const pageSlug = pageNamed.slug;
      if (pageSlugs.has(pageSlug)) problems.push(`${where}: slug "${pageSlug}" is also used by ${pageSlugs.get(pageSlug)}`);
      pageSlugs.set(pageSlug, pageEntry.name);
      const page = readPage(root, join(dir, pageEntry.name), 'page', `/help/${slug}/${pageSlug}/`, problems);
      page.chapter = chapter;
      pageOrder.set(page, pageNamed.order);
      if (visible(page)) chapter.pages.push(page);
    }
    chapter.pages.sort((a, b) => pageOrder.get(a)! - pageOrder.get(b)!);
    if (visible(intro)) chapters.push(chapter);
  }
  // Folder numbers only order; readers see chapters counted from one, so a
  // chapter can be slotted in as 25- without renumbering its neighbours.
  chapters.sort((a, b) => a.number - b.number).forEach((chapter, index) => { chapter.number = index + 1; });

  if (problems.length > 0 || !home) throw new HelpContentError(problems);
  const pages = [home, ...chapters.flatMap((chapter) => [chapter.intro, ...chapter.pages])];
  return { root, home, chapters, pages };
}
