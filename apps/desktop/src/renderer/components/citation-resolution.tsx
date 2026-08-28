import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
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

  const request = useCallback((resourceId: string) => {
    if (!api) return;
    setResolutions((current) => {
      if (current.has(resourceId)) return current;
      const next = new Map(current);
      next.set(resourceId, { status: 'pending' });
      return next;
    });
    void queryClient.fetchQuery({
      queryKey: ['resource', resourceId],
      queryFn: ({ signal }) => api.getResource(resourceId, signal),
      staleTime: Number.POSITIVE_INFINITY,
    }).then((resource) => {
      setResolutions((current) => new Map(current).set(resourceId, {
        status: 'resolved',
        resource: { resourceType: resource.resourceType },
      }));
    }).catch(() => {
      setResolutions((current) => new Map(current).set(resourceId, { status: 'unavailable' }));
    });
  }, [api, queryClient]);

  const resolver = useMemo<CitationResolver>(() => ({
    request,
    resolve: (resourceId) => resolutions.get(resourceId) ?? { status: 'pending' },
  }), [request, resolutions]);

  return <CitationResolutionContext.Provider value={resolver}>{children}</CitationResolutionContext.Provider>;
}
