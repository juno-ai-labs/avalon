import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * A typed `@address` mention: how a message names somebody invited to the
 * Organization who has no account yet. One reading, shared by the renderer
 * that draws the chip and the composer that shares the conversation with the
 * address, so an address is never shared with unless it also draws as a chip.
 *
 * The composer's boundaries: an opening space or bracket (or the start of a
 * text node) before the `@`, and a space, punctuation, or the end after the
 * address. The address is read whole, so `@dana@example.com.au` names that
 * address and never `dana@example.com`.
 */
export const EMAIL_MENTION = /(^|[\s([{])(@([^\s@()<>[\]{},;:"']+@[^\s@()<>[\]{},;:"']+\.[a-z]{2,}))(?=[\s\p{P}]|$)/giu;
/** An `@` closing a text node: GFM turned the address after it into a `mailto:` link. */
export const EMAIL_MENTION_AT = /(^|[\s([{])@$/u;

export interface EmailMentionNode {
  type: string;
  value?: string;
  url?: unknown;
  children?: EmailMentionNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

/**
 * The address of a link GFM made from a bare address, or undefined for any
 * other link. The source span is what tells them apart: an explicitly written
 * `[a@b.com](mailto:a@b.com)` has the same URL and label, but its source is
 * the bracketed form, and an explicit link is never a mention.
 */
export function bareAddressAutolink(node: EmailMentionNode | undefined, source: string): string | undefined {
  if (node?.type !== "link" || typeof node.url !== "string") return undefined;
  const label = node.children?.length === 1 && node.children[0]?.type === "text" ? node.children[0].value : undefined;
  if (label === undefined || node.url !== `mailto:${label}`) return undefined;
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (start === undefined || end === undefined || source.slice(start, end) !== label) return undefined;
  return label;
}

/**
 * Every address a message mentions, lower case, first mention first. Code
 * and explicit links are skipped, as the renderer skips them, so an address
 * quoted in a code block or written as a link is not a mention.
 */
export function emailMentionAddresses(markdown: string): string[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as EmailMentionNode;
  const found: string[] = [];
  const note = (address: string): void => {
    const email = address.toLowerCase();
    if (!found.includes(email)) found.push(email);
  };
  const visit = (node: EmailMentionNode): void => {
    if (node.type === "link" || node.type === "code" || node.type === "inlineCode") return;
    const children = node.children ?? [];
    children.forEach((child, index) => {
      if (child.type !== "text" || child.value === undefined) {
        visit(child);
        return;
      }
      for (const match of child.value.matchAll(EMAIL_MENTION)) note(match[3]!);
      if (EMAIL_MENTION_AT.test(child.value)) {
        const address = bareAddressAutolink(children[index + 1], markdown);
        if (address !== undefined) note(address);
      }
    });
  };
  visit(tree);
  return found;
}
