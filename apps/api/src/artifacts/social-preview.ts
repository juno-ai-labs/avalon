import type { ArtifactSocialPreview } from "@rally/contracts";

/** Build the complete crawler-facing metadata set for one successful page. */
export function socialPreviewMarkup(
  preview: ArtifactSocialPreview,
  requestUrl: URL,
  artifactVersion: number,
): string {
  const canonical = new URL(requestUrl);
  canonical.search = "";
  canonical.hash = "";
  const image = new URL(`/${preview.image.path}`, canonical.origin);
  image.searchParams.set("v", String(artifactVersion));
  const values = {
    title: escapeHtmlAttribute(preview.title),
    description: escapeHtmlAttribute(preview.description),
    canonical: escapeHtmlAttribute(canonical.href),
    image: escapeHtmlAttribute(image.href),
    imageType: escapeHtmlAttribute(preview.image.contentType),
    imageAlt: escapeHtmlAttribute(preview.image.alt),
  };
  return [
    `<link rel="canonical" href="${values.canonical}">`,
    `<meta name="description" content="${values.description}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Rally">`,
    `<meta property="og:title" content="${values.title}">`,
    `<meta property="og:description" content="${values.description}">`,
    `<meta property="og:url" content="${values.canonical}">`,
    `<meta property="og:image" content="${values.image}">`,
    `<meta property="og:image:secure_url" content="${values.image}">`,
    `<meta property="og:image:type" content="${values.imageType}">`,
    `<meta property="og:image:width" content="${preview.image.width}">`,
    `<meta property="og:image:height" content="${preview.image.height}">`,
    `<meta property="og:image:alt" content="${values.imageAlt}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${values.title}">`,
    `<meta name="twitter:description" content="${values.description}">`,
    `<meta name="twitter:image" content="${values.image}">`,
    `<meta name="twitter:image:alt" content="${values.imageAlt}">`,
  ].join("\n");
}

/** Inject into bounded, published HTML bytes without depending on the runtime. */
export function injectSocialPreviewIntoHtml(source: string, markup: string): string {
  const head = /<head\b[^>]*>/iu.exec(source);
  if (head?.index !== undefined) {
    const offset = head.index + head[0].length;
    return `${source.slice(0, offset)}\n${markup}\n${source.slice(offset)}`;
  }
  const html = /<html\b[^>]*>/iu.exec(source);
  if (html?.index !== undefined) {
    const offset = html.index + html[0].length;
    return `${source.slice(0, offset)}<head>\n${markup}\n</head>${source.slice(offset)}`;
  }
  return `<head>\n${markup}\n</head>${source}`;
}

/**
 * Transform an active site's possibly-streaming HTML response. Only successful
 * HTML is touched, so a protected site's 401 and an API's JSON remain exact.
 */
export function injectSocialPreviewResponse(response: Response, markup: string): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (response.status < 200 || response.status >= 300 || !contentType.startsWith("text/html")) {
    return response;
  }
  let injected = false;
  return new HTMLRewriter()
    .on("head", {
      element(element) {
        element.prepend(`${markup}\n`, { html: true });
        injected = true;
      },
    })
    .on("body", {
      element(element) {
        if (injected) return;
        element.before(`<head>\n${markup}\n</head>`, { html: true });
        injected = true;
      },
    })
    .transform(response);
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
