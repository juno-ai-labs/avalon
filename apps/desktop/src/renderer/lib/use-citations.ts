import type { CitationTarget } from '@rally/contracts/citations';
import { useCallback, useMemo } from 'react';
import type { CitationContext, CitationResource } from '../components/markdown-citations';
import { desktopBridge } from './platform';
import type { WorkstreamResource } from './types';
import { useUiStore } from './ui-store';

/**
 * What a citation resolves to, and where clicking one goes.
 *
 * The renderer knows the protocol; this knows the application. It answers two
 * questions for every citation on screen — *what is this resource* and *what
 * happens when somebody clicks it* — and it is the only place either answer is
 * decided, so a surface with no work stream behind it simply does not build one
 * and every citation on it degrades to the label text.
 *
 * **Resolution is the loaded work stream's resource set, and nothing else.**
 * That is a deliberate narrowing from the PRD, which described dressing a chip
 * from the workspace's resource authority so a citation naming a resource from
 * *another* work stream would still render as one. The reason is where such a
 * chip leads: the rail's detail resolves from `workstream.resources` too, so a
 * chip the wider lookup dressed opens the rail's unavailable state — which
 * tells the reader the resource "may have been removed", of something that
 * exists and that they may well be entitled to see. A citation that renders as
 * its own label text says less and says nothing false, and it is the
 * degradation the rest of this feature already leans on.
 *
 * The wider lookup belongs with the rail's fetch-by-id detail, which the PRD
 * names as follow-up work it does not include. Bringing it back means adding a
 * tier here and a fetch in the rail in one change, so that the chip and the
 * panel it opens agree about what exists.
 */
export function useCitations({ resources }: {
  resources: WorkstreamResource[];
}): CitationContext {
  const inspect = useUiStore((state) => state.inspect);
  const openRail = useUiStore((state) => state.openRail);

  /**
   * Both spellings of a resource's identity, mapped to the one resource.
   *
   * `list_resources` hands the model a UUID *and* a short alias, and the
   * citation grammar accepts either — so the alias is what a model writes once
   * it has seen one. Indexing only the UUID would drop those chips silently,
   * which is the degradation this feature exists to avoid rather than a
   * degradation it can lean on.
   */
  const local = useMemo(() => {
    const byToken = new Map<string, CitationResource>();
    for (const resource of resources) {
      const citation = { id: resource.id, resourceType: resource.resourceType, title: resource.title };
      byToken.set(resource.id, citation);
      if (resource.slug) byToken.set(resource.slug, citation);
    }
    return byToken;
  }, [resources]);

  const resolve = useCallback(
    (token: string): CitationResource | undefined => local.get(token),
    [local],
  );

  const open = useCallback((target: CitationTarget): void => {
    if (target.scheme === 'external') {
      void desktopBridge().openExternal(target.url);
      return;
    }
    // An identity names somebody, not something openable, and an unknown target
    // names nothing — neither navigates, in any position.
    if (target.scheme !== 'resource') return;
    // Through the resolver rather than straight from the citation: the rail's
    // detail is keyed by the resource's own id, and a citation may name it by
    // its alias instead. An unresolved target opens nothing — the renderer
    // already leaves it as label text, and this is the same answer.
    const resource = local.get(target.resourceId);
    if (!resource) return;
    // The order is the contract. `openRail` clears the inspector deliberately,
    // so selecting the resource first would leave the rail showing its list.
    openRail('context');
    inspect({ type: 'resource', id: resource.id });
  }, [inspect, local, openRail]);

  return useMemo(() => ({ open, resolve }), [open, resolve]);
}
