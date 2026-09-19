import { useEffect, useState } from 'react';
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
 */
export function useHostFavicon(href: string | undefined): string | null {
  const api = useFaviconApi();
  const hostname = httpHostname(href);
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    if (!api || !hostname) return;
    let active = true;
    let objectUrl: string | null = null;
    void api.getFavicon(hostname)
      .then((blob) => {
        if (!blob || !active) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, hostname]);
  return source;
}
