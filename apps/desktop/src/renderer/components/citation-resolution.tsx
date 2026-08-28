import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ApiError } from '../lib/api';
import { useAppSession } from '../lib/app-session';
import {
  CitationResolutionContext,
  type CitationResolution,
  type CitationResolver,
} from './citations';

/**
 * Answers what a cited resource is, for every citation on screen.
 *
 * A citation names an arbitrary resource id. Most of them are in the work
 * stream the reader has open, but a run can cite a document from another one,
 * and the renderer has no way to know which case it is looking at — so this
 * reads the resource by id under the viewer's own authorization and caches the
 * answer for the session.
 *
 * **Why a fetch and not a push.** `docs/choosing-sockets-or-rest.md` pushes
 * what a window will paint and fetches what a person went looking for, and a
 * chip's icon is paint. What decides it the other way is that the id is
 * unbounded: nothing can push what it cannot enumerate, and the alternative is
 * sending every resource in the workspace to every window on connect for the
 * few a message happens to cite. Each id is read once and then cached, which is
 * far closer to "rare and deep" than to a surface that goes stale. If it ever
 * has to become a push, this component is the only thing that changes.
 *
 * A failed read is not an error state anybody sees: it degrades the citation to
 * the label text the message already carried, which is also what an
 * unauthorized read has to look like — a citation grants no access, and telling
 * a reader that a resource they cannot see exists would be a disclosure the
 * message did not make.
 */
export function CitationResolutionProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { api } = useAppSession();
  const queryClient = useQueryClient();
  const [resolutions, setResolutions] = useState<ReadonlyMap<string, CitationResolution>>(new Map());

  // What has already been asked for. A ref rather than the resolutions map,
  // because the map is read during render and this has to be consulted *before*
  // the fetch: a guard inside the state updater short-circuits the state write
  // and nothing else, so the request still went out. That was invisible for a
  // resource that resolves — `staleTime` makes the second fetch a no-op — and a
  // steady trickle of 403s for one that does not, on any transcript that
  // scrolls a chip in and out of view.
  const requested = useRef<Set<string>>(new Set());

  const request = useCallback((resourceId: string) => {
    if (!api || requested.current.has(resourceId)) return;
    requested.current.add(resourceId);
    setResolutions((current) => new Map(current).set(resourceId, { status: 'pending' }));
    void queryClient.fetchQuery({
      queryKey: ['resource', resourceId],
      queryFn: ({ signal }) => api.getResource(resourceId, signal),
      staleTime: Number.POSITIVE_INFINITY,
    }).then((resource) => {
      setResolutions((current) => new Map(current).set(resourceId, {
        status: 'resolved',
        resource: { resourceType: resource.resourceType },
      }));
    }).catch((error: unknown) => {
      // Only a denial degrades the chip to text. A 500, a dropped connection or
      // an offline window is not "you cannot see this" — collapsing an
      // affordance the reader is looking at, seconds after it appeared, and
      // never restoring it, is worse than leaving the chip drawn from the label
      // the message already carried.
      const denied = error instanceof ApiError && (error.status === 404 || error.status === 403);
      if (!denied) return;
      setResolutions((current) => new Map(current).set(resourceId, { status: 'unavailable' }));
    });
  }, [api, queryClient]);

  const resolver = useMemo<CitationResolver>(() => ({
    request,
    resolve: (resourceId) => resolutions.get(resourceId) ?? { status: 'pending' },
  }), [request, resolutions]);

  return <CitationResolutionContext.Provider value={resolver}>{children}</CitationResolutionContext.Provider>;
}
