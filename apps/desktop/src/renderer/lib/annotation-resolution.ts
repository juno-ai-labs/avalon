import { annotationAllowedForResource, ANNOTATION_CONTEXT_CHARACTERS, type Annotation, type AnnotationLocator } from '@rally/contracts';
import { annotationCellRange, annotationRange, annotationSheets } from './annotation-cells';

export type AnnotationResolution = { state: 'ready'; annotation: Annotation } | { state: 'needs-attention'; reason: string };
const missing = (): AnnotationResolution => ({ state: 'needs-attention', reason: 'This selection changed or could not be located. Reattach the comment to send it.' });

function occurrences(text: string, quote: string): number[] {
  if (!quote) return [];
  const positions: number[] = [];
  for (let index = text.indexOf(quote); index !== -1; index = text.indexOf(quote, index + 1)) positions.push(index);
  return positions;
}

function headings(text: string, start: number): string[] {
  return [...text.slice(0, start).matchAll(/^(#{1,6})\s+(.+)$/gmu)].reduce<string[]>((path, h) => {
    path.length = Math.min(path.length, h[1]!.length - 1); path.push(h[2]!); return path;
  }, []);
}
function textLocator(locator: AnnotationLocator, text: string, start: number, end: number): AnnotationLocator {
  if (locator.type === 'markdown' || locator.type === 'document-text') return { ...locator, start, end, headingPath: headings(text, start) };
  if (locator.type === 'pdf-text') return { ...locator, start, end, page: Number([...text.slice(0, start).matchAll(/^# Page (\d+)/gmu)].at(-1)?.[1] ?? 1) };
  if (locator.type === 'slide-text') return { ...locator, start, end, slide: Number([...text.slice(0, start).matchAll(/^# Slide (\d+)/gmu)].at(-1)?.[1] ?? 1) };
  return { type: 'text', start, end, lines: [text.slice(0, start).split('\n').length, text.slice(0, end).split('\n').length] };
}
function sameSection(a: AnnotationLocator, b: AnnotationLocator): boolean {
  if ('headingPath' in a && 'headingPath' in b) return a.headingPath.length > 0 && JSON.stringify(a.headingPath) === JSON.stringify(b.headingPath);
  if ('page' in a && 'page' in b) return a.page === b.page;
  if ('slide' in a && 'slide' in b) return a.slide === b.slide;
  return false;
}
function elementHtml(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll('script,style,[data-rally-picker]').forEach((node) => node.remove());
  for (const node of [clone, ...clone.querySelectorAll('*')]) for (const attr of [...node.attributes]) {
    if (attr.name.startsWith('on') || attr.name === 'd' || attr.value.trim().startsWith('data:')) node.removeAttribute(attr.name);
  }
  return clone.outerHTML.replace(/\s+/gu, ' ').trim();
}
function elementSelector(element: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = element; node && node.tagName !== 'HTML'; node = node.parentElement) {
    const siblings = [...(node.parentElement?.children ?? [])].filter((sibling) => sibling.tagName === node!.tagName);
    parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
  }
  return parts.join(' > ');
}

/** No guessed similarity score: ambiguous candidates require the author's repair. */
export function resolveAnnotationText(annotation: Annotation, text: string, version: number): AnnotationResolution {
  const locator = annotation.target.locator;
  const ready = (next: AnnotationLocator, exact = annotation.content.exact, before = annotation.content.before, after = annotation.content.after): AnnotationResolution => ({
    state: 'ready', annotation: { ...annotation, target: { ...annotation.target, version, locator: next }, content: { ...annotation.content, exact, before, after } },
  });
  if (locator.type === 'file') return ready(locator);
  if (annotation.content.truncated) return missing();
  if ('start' in locator) {
    const { exact, before, after } = annotation.content;
    let candidates = occurrences(text, exact);
    const contextMatches = (start: number, end: number): boolean => (!before || text.slice(0, start).endsWith(before)) && (!after || text.slice(end).startsWith(after));
    if (candidates.length > 1) candidates = candidates.filter((start) => contextMatches(start, start + exact.length));
    let start = candidates.length === 1 ? candidates[0]! : -1;
    let end = start + exact.length;
    if (start < 0 && before && after) {
      const ranges = occurrences(text, before).flatMap((position) => {
        const from = position + before.length;
        return occurrences(text.slice(from), after).map((offset) => ({ start: from, end: from + offset }));
      }).filter((range) => range.end > range.start && sameSection(locator, textLocator(locator, text, range.start, range.end))
        && sameSection(locator, textLocator(locator, text, range.end - 1, range.end)));
      if (ranges.length === 1) ({ start, end } = ranges[0]!);
    }
    if (start < 0) return missing();
    return ready(textLocator(locator, text, start, end), text.slice(start, end), text.slice(Math.max(0, start - ANNOTATION_CONTEXT_CHARACTERS), start), text.slice(end, end + ANNOTATION_CONTEXT_CHARACTERS));
  }
  if (locator.type === 'cells') {
    const range = annotationRange(locator.range);
    const sheet = annotationSheets(text).find((entry) => entry.name === locator.sheet);
    if (!range || !sheet) return missing();
    const matches: ReturnType<typeof annotationCellRange>[] = [];
    const height = range.end[0] - range.start[0]; const width = range.end[1] - range.start[1];
    const columns = Math.max(0, ...Object.values(sheet.cells).map((row) => row.length));
    for (let row = 0; row + height < sheet.cells.length; row += 1) for (let column = 0; column + width < columns; column += 1) {
      const candidate = annotationCellRange(sheet, [row, column], [row + height, column + width]);
      if (candidate.table === annotation.content.exact) matches.push(candidate);
    }
    const original = matches.find((match) => match.range === locator.range);
    const match = original ?? (matches.length === 1 ? matches[0] : undefined);
    return match ? ready({ ...locator, range: match.range }, match.table) : missing();
  }
  if (locator.type === 'element') {
    const document = new DOMParser().parseFromString(text, 'text/html');
    const matches = [...document.body.querySelectorAll('*')].filter((element) => elementHtml(element) === annotation.content.exact && (element.textContent ?? '').includes(locator.visibleText));
    let match: Element | undefined;
    if (matches.length === 1) match = matches[0];
    if (!match && !matches.length) {
      const original = new DOMParser().parseFromString(annotation.content.exact, 'text/html').body.firstElementChild;
      const id = original?.id;
      const candidates = id ? [...document.querySelectorAll('[id]')].filter((element) => element.id === id) : [];
      const candidate = candidates.length === 1 ? candidates[0] : undefined;
      if (candidate && annotation.content.before && annotation.content.after
        && candidate.previousElementSibling?.textContent === annotation.content.before
        && candidate.nextElementSibling?.textContent === annotation.content.after) match = candidate;
    }
    if (!match) return missing();
    return ready({ ...locator, css: elementSelector(match), visibleText: match.textContent ?? '' }, elementHtml(match), match.previousElementSibling?.textContent ?? '', match.nextElementSibling?.textContent ?? '');
  }
  return missing();
}

export interface AnnotationReader {
  readResource: (id: string) => Promise<{ currentVersion: number; title?: string; mimeType?: string | null }>;
  readResourceVersion: (id: string, version: number, signal: AbortSignal, annotation?: Annotation) => Promise<Blob>;
}
export async function resolveAnnotation(annotation: Annotation, reader: AnnotationReader, signal: AbortSignal): Promise<AnnotationResolution> {
  try {
    const { resourceId, version, locator } = annotation.target;
    const resource = await reader.readResource(resourceId);
    if (signal.aborted) return missing();
    if (resource.title && resource.mimeType && resource.mimeType!=='application/vnd.rally.site-manifest+json' && !annotationAllowedForResource(annotation,{fileName:resource.title,mimeType:resource.mimeType})) return missing();
    if (resource.currentVersion === version) return { state: 'ready', annotation };
    if (locator.type === 'file') return { state: 'ready', annotation: { ...annotation, target: { ...annotation.target, version: resource.currentVersion } } };
    const blob = await reader.readResourceVersion(resourceId, resource.currentVersion, signal, annotation);
    if (locator.type === 'region') {
      const original = await reader.readResourceVersion(resourceId, version, signal, annotation);
      const [a, b] = await Promise.all([original.arrayBuffer(), blob.arrayBuffer()]);
      const bytes = new Uint8Array(b);
      return a.byteLength === b.byteLength && new Uint8Array(a).every((byte, index) => byte === bytes[index])
        ? { state: 'ready', annotation: { ...annotation, target: { ...annotation.target, version: resource.currentVersion } } } : missing();
    }
    const result = resolveAnnotationText(annotation, await blob.text(), resource.currentVersion);
    if (signal.aborted || (await reader.readResource(resourceId)).currentVersion !== resource.currentVersion) return {state:'needs-attention',reason:'The artifact changed while checking this comment. Retry to use its latest revision.'};
    if (result.state==='ready' && locator.type==='element' && result.annotation.content.imageAttachmentId) {
      const content={...result.annotation.content};
      delete content.imageAttachmentId;
      return {state:'ready',annotation:{...result.annotation,content}};
    }
    return result;
  } catch {
    return { state: 'needs-attention', reason: 'The artifact could not be checked. Retry when it is available.' };
  }
}
