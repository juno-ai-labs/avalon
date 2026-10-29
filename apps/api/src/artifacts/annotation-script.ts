/**
 * Getting Rally's annotation script into the pages Rally viewers see.
 *
 * The desktop and the browser client both point at parts of a live artifact,
 * and neither can add a script to the artifact's document from outside: the
 * desktop's view has no preload and the browser's frame is another origin. So
 * the serving Worker puts the script into the page itself, for every HTML
 * response a Rally viewer gets, and nothing else: a public read, a crawler or
 * an unfurler gets the page as published.
 *
 * The script is served from a reserved path on the artifact origin so the
 * artifact CSP's `script-src 'self'` admits it. See
 * `docs/artifact-annotations.md` and `docs/live-web-artifacts.md`.
 */
import { artifactAnnotationScript, artifactAnnotationScriptPath } from "@rally/contracts";

/**
 * Which script path to inject for this request, or `null` for none.
 *
 * A valid viewer session is the desktop's `WebContentsView` and pop-out, or a
 * person who opened the site in their own browser from Rally: the script is
 * inert for them, there being no host to call it. A framed request is the
 * browser client's preview, which `frame-ancestors` restricts to that one
 * origin; it is admitted without a session because Safari refuses the
 * partitioned cookie and views the public page, and `parentOrigin` is the
 * only parent the script will then listen to.
 */
export function annotationScriptPathFor(input: {
  viewerId: string | null;
  request: Request;
  parentOrigin: string | null;
}): string | null {
  const framed = input.request.headers.get("sec-fetch-dest") === "iframe" && input.parentOrigin !== null;
  if (!input.viewerId && !framed) return null;
  return scriptPath(input.parentOrigin);
}

// The script and its hash are the same for every request of an isolate, so
// they are built once per origin rather than once per asset served.
const built = new Map<string | null, { path: string; source: string }>();
function script(parentOrigin: string | null): { path: string; source: string } {
  let entry = built.get(parentOrigin);
  if (!entry) {
    entry = { path: artifactAnnotationScriptPath(parentOrigin), source: artifactAnnotationScript(parentOrigin) };
    built.set(parentOrigin, entry);
  }
  return entry;
}
const scriptPath = (parentOrigin: string | null): string => script(parentOrigin).path;

/**
 * The served script, never sniffed. A browser may keep it for a year only
 * under this isolate's own content-addressed path: while a deploy rolls out,
 * an older isolate can be asked for the newer path, and what it serves then
 * must not be cached as if it were the newer script.
 */
export function annotationScriptResponse(parentOrigin: string | null, requestedPath: string): Response {
  const { path, source } = script(parentOrigin);
  return new Response(source, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": requestedPath === path ? "public, max-age=31536000, immutable" : "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Deferred: the page parses and starts rendering without waiting on the
 * fetch, and the script still runs before `DOMContentLoaded`, which is all
 * any host waits for.
 */
function scriptTag(path: string): string {
  return `<script defer src="${path}"></script>`;
}

/**
 * Put the script first in `<head>`, in buffered static HTML.
 *
 * First rather than last for two reasons: a page's own `<meta>` policy applies
 * only from where it is parsed, so a script before it cannot be refused by
 * accident, and the script captures nothing from the page but must install
 * before page code looks for it.
 */
export function injectAnnotationScriptIntoHtml(source: string, path: string): string {
  const tag = scriptTag(path);
  const head = openingTag(source, "head");
  if (head !== null) return `${source.slice(0, head)}${tag}${source.slice(head)}`;
  const html = openingTag(source, "html");
  if (html !== null) return `${source.slice(0, html)}<head>${tag}</head>${source.slice(html)}`;
  const doctype = /^\s*<!doctype\b[^>]*>/iu.exec(source);
  if (doctype) {
    return `${source.slice(0, doctype[0].length)}<head>${tag}</head>${source.slice(doctype[0].length)}`;
  }
  return `<head>${tag}</head>${source}`;
}

/** Where the first real `<name …>` tag ends, skipping any inside a comment. */
function openingTag(source: string, name: string): number | null {
  const scan = new RegExp(`<!--[\\s\\S]*?(?:-->|$)|<${name}\\b[^>]*>`, "giu");
  for (const match of source.matchAll(scan)) {
    if (!match[0].startsWith("<!--")) return match.index + match[0].length;
  }
  return null;
}

/**
 * The same, on an active site's possibly streaming response. Only successful
 * HTML is touched, so a protected site's 401 and an API's JSON stay exact.
 */
export function injectAnnotationScriptResponse(response: Response, path: string): Response {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (response.status < 200 || response.status >= 300 || !contentType.startsWith("text/html")) {
    return response;
  }
  const tag = scriptTag(path);
  let injected = false;
  return new HTMLRewriter()
    .on("head", {
      element(element) {
        if (injected) return;
        element.prepend(tag, { html: true });
        injected = true;
      },
    })
    .on("body", {
      element(element) {
        if (injected) return;
        element.before(`<head>${tag}</head>`, { html: true });
        injected = true;
      },
    })
    .on("*", {
      element(element) {
        if (injected || ["html", "head", "body"].includes(element.tagName)) return;
        element.before(`<head>${tag}</head>`, { html: true });
        injected = true;
      },
    })
    .onDocument({
      end(end) {
        if (!injected) end.append(`<head>${tag}</head>`, { html: true });
      },
    })
    .transform(response);
}
