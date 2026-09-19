import { useCallback, useEffect, useState } from 'react';
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

/** What a caller needs to draw a host's icon, and to stop drawing it. */
export interface HostFavicon {
  /** An object URL, or null while there is nothing to draw. */
  readonly source: string | null;
  /** The `<img>`'s `onError`: what was fetched is not an image this renderer can paint. */
  readonly onError: () => void;
}

/**
 * A host's favicon as an object URL, or null while there is none to draw.
 *
 * Null covers four distinct states on purpose: the host has no icon, the
 * request has not landed yet, the surface has no API to ask — a detached still
 * export, or a focused test — and the bytes that came back would not decode. A
 * caller cannot usefully tell them apart, because the answer in every one of
 * them is to draw whatever it draws without an icon.
 *
 * The last of those is the reason `onError` is part of the contract rather than
 * each caller's business. The endpoint validates that it is serving an image
 * and serves `image/svg+xml` among others, so a blob can be a perfectly good
 * response and still fail to paint here; without this the element left in the
 * DOM is a broken-image glyph. In front of a link that is a bad decoration, and
 * in a marker it is worse than nothing — the icon is the whole signal, so the
 * reader gets a broken glyph where the asterisk was promised.
 *
 * The lifetime is the caller's mount: a response that arrives after the link
 * has scrolled out of a virtualised transcript is dropped rather than set, and
 * the object URL is revoked on the way out, because a blob URL nobody revokes
 * holds its bytes for the life of the window.
 *
 * **What the result is answering for travels with it**, which is why this holds
 * a record rather than a bare string, and why the record dies with the object
 * URL it names. A caller's target can change under a
 * mount that React keeps — a footnote marker holds its position across a
 * re-parse, so a definition re-pointed at another host hands the same component
 * a new hostname — and the effect that revokes the old object URL runs *after*
 * that render. A bare `source` would therefore be handed back for one paint
 * pointing at revoked bytes, and indefinitely if the new host's request comes
 * back empty or never lands: a broken image where the asterisk belongs. Reading
 * the result only when it still matches makes the stale case impossible to
 * render rather than a race to be won.
 */
export function useHostFavicon(href: string | undefined): HostFavicon {
  const api = useFaviconApi();
  const hostname = httpHostname(href);
  const [resolved, setResolved] = useState<{ api: RallyApi; hostname: string; source: string } | null>(null);
  // Dropping the record is enough to stop drawing it: the effect does not
  // re-run while the target holds still, so nothing re-offers the same bytes.
  // The URL itself is still revoked by the cleanup that owns it.
  const onError = useCallback(() => setResolved(null), []);
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
      if (!objectUrl) return;
      URL.revokeObjectURL(objectUrl);
      // Drop the record with the URL it names. Not reading it is enough while
      // the target has moved on, but the record outlives that: a marker
      // re-pointed away and then back — A, B, A — would match the guard again
      // and hand back bytes revoked on the way out, which is an `<img>`
      // pointing at nothing and so an empty plate rather than the asterisk.
      setResolved((current) => (current?.source === objectUrl ? null : current));
    };
  }, [api, hostname]);
  const source = resolved !== null && resolved.api === api && resolved.hostname === hostname ? resolved.source : null;
  return { onError, source };
}
