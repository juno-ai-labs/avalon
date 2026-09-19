import { useEffect, useState } from 'react';
import type { RallyApi } from './api';
import { useFaviconApi } from './favicon-api';

/**
 * A host's own icon, for the surfaces that draw one.
 *
 * Separate from `favicon-api`, which is capability plumbing: that module
 * narrows the session context to the one thing a Markdown body may read, and
 * this one owns what is done with it. Two callers draw the same icon in
 * incompatible boxes — a web link puts it in front of its text, a citation pill
 * puts it *instead of* its asterisk, where the absent case is a glyph rather
 * than empty space — so the shared piece is the part that is easy to get wrong,
 * not the markup.
 */

/** The hostname an HTTP(S) target names, or null for everything else. */
export function httpHostname(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : null;
  } catch {
    return null;
  }
}

/**
 * A host's favicon as an object URL, or null while there is none to draw.
 *
 * Null covers three distinct states on purpose: the host has no icon, the
 * request has not landed yet, and the surface has no API to ask — a detached
 * still export, or a focused test. A caller cannot usefully tell them apart,
 * because the answer in every one of them is to draw whatever it draws without
 * an icon.
 *
 * The lifetime is the caller's mount: a response that arrives after the link
 * has scrolled out of a virtualised transcript is dropped rather than set, and
 * the object URL is revoked on the way out, because a blob URL nobody revokes
 * holds its bytes for the life of the window.
 *
 * **What the result is answering for travels with it**, which is why this holds
 * a record rather than a bare string. A caller's target can change under a
 * mount that React keeps — a footnote marker holds its position across a
 * re-parse, so a definition re-pointed at another host hands the same component
 * a new hostname — and the effect that revokes the old object URL runs *after*
 * that render. A bare `source` would therefore be handed back for one paint
 * pointing at revoked bytes, and indefinitely if the new host's request comes
 * back empty or never lands: a broken image where the asterisk belongs. Reading
 * the result only when it still matches makes the stale case impossible to
 * render rather than a race to be won.
 */
export function useHostFavicon(href: string | undefined): string | null {
  const api = useFaviconApi();
  const hostname = httpHostname(href);
  const [resolved, setResolved] = useState<{ api: RallyApi; hostname: string; source: string } | null>(null);
  useEffect(() => {
    if (!api || !hostname) return;
    let active = true;
    let objectUrl: string | null = null;
    void api.getFavicon(hostname)
      .then((blob) => {
        if (!blob || !active) return;
        objectUrl = URL.createObjectURL(blob);
        setResolved({ api, hostname, source: objectUrl });
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, hostname]);
  return resolved !== null && resolved.api === api && resolved.hostname === hostname ? resolved.source : null;
}
