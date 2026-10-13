/**
 * Reading a page's own metadata out of its HTML source: the `<title>`, a
 * `<meta>` tag's content, and the text of a first element. These are regular
 * expressions over source text rather than a parser, which is enough for the
 * head of a page and runs the same in the Node suite as in workerd.
 */

/** The inner source of the first `<tag>`, or null when there is none. */
export function htmlElementText(source: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "iu").exec(source);
  return match?.[1] ?? null;
}

/** The `content` of the first `<meta>` whose `name` or `property` is `expected`. */
export function htmlMetaContent(source: string, key: "name" | "property", expected: string): string | null {
  for (const match of source.matchAll(/<meta\b[^>]*>/giu)) {
    const attributes = htmlAttributes(match[0]);
    if (attributes.get(key)?.toLowerCase() === expected) return attributes.get("content") ?? null;
  }
  return null;
}

/** Markup stripped, entities decoded, and whitespace collapsed to single spaces. */
export function normalizeHtmlText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
}

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|quot|apos|lt|gt|nbsp);/giu, (entity, decimal, hex) => {
    if (decimal || hex) {
      const codePoint = decimal ? Number(decimal) : Number.parseInt(hex, 16);
      return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    return ({
      "&amp;": "&",
      "&quot;": "\"",
      "&apos;": "'",
      "&lt;": "<",
      "&gt;": ">",
      "&nbsp;": " ",
    } as Record<string, string>)[entity.toLowerCase()] ?? entity;
  });
}

function htmlAttributes(tag: string): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu;
  for (const match of tag.matchAll(pattern)) {
    result.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}
