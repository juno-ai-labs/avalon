import type { CitationTarget } from '@rally/contracts/citations';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CitationContext, CitationResource } from '../components/markdown-citations';
import type { RallyApi } from './api';
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
 * **Resolution is two-tier, and both tiers matter.** A cited resource is usually
 * one the loaded work stream already carries, and that lookup is synchronous —
 * the chip is there on the first paint with no flicker. But a citation can name
 * a resource from another work stream, and the metadata it needs (title, kind)
 * belongs to the workspace, not to this screen. That falls back to the
 * workspace-scoped `GET /resources/:id`, which already exists and already
 * enforces the viewer's authorization — no new endpoint, no proactive push of
 * data nobody has cited. `choosing-sockets-or-rest.md` governs, and this is the
 * shape it calls a `GET`: a viewer-triggered lookup of one arbitrary id.
 *
 * **A failure and a denial are the same answer.** The endpoint returns the same
 * error for a resource that does not exist and one this viewer may not see, and
 * that is deliberate: the chip degrades to label text either way, so a citation
 * can never become a way to learn that something exists.
 */
export function useCitations({ api, resources }: {
  /**
   * Narrowed to the one call this makes, rather than the whole client: it keeps
   * the dependency honest and lets a test hand over the capability instead of
   * pretending to be an API.
   */
  api: Pick<RallyApi, 'getResource'> | null;
  resources: WorkstreamResource[];
}): CitationContext {
  const inspect = useUiStore((state) => state.inspect);
  const openRail = useUiStore((state) => state.openRail);
  const [fetched, setFetched] = useState<ReadonlyMap<string, CitationResource>>(EMPTY);
  /**
   * Ids a citation asked for and neither tier could answer yet.
   *
   * Collected during render, into a ref rather than state: `resolve` is called
   * from inside the markdown tree, once per citation, and a `setState` there
   * would be a render-phase update of a parent. The set is idempotent — adding
   * the same id twice is the same set — so a double render adds nothing, and the
   * effect below is what turns it into requests.
   */
  const wanted = useRef(new Set<string>());
  /**
   * Every id this mount has already requested, answered or not.
   *
   * One set, not two: an id that came back denied and an id still in flight are
   * both "do not ask again", and splitting them into an in-flight guard and a
   * remembered-miss guard would make one of the two unreachable — a branch no
   * test could tell from the other.
   */
  const asked = useRef(new Set<string>());

  const local = useMemo(() => {
    const byId = new Map<string, CitationResource>();
    for (const resource of resources) {
      byId.set(resource.id, { id: resource.id, resourceType: resource.resourceType, title: resource.title });
    }
    return byId;
  }, [resources]);

  const resolve = useCallback((resourceId: string): CitationResource | undefined => {
    const loaded = local.get(resourceId);
    if (loaded) return loaded;
    const remote = fetched.get(resourceId);
    if (remote) return remote;
    wanted.current.add(resourceId);
    return undefined;
  }, [fetched, local]);

  useEffect(() => {
    if (!api) return;
    const pending = [...wanted.current].filter((id) => !asked.current.has(id) && !local.has(id));
    if (pending.length === 0) return;
    for (const id of pending) asked.current.add(id);
    let live = true;
    void Promise.all(pending.map(async (id) => {
      const resource = await api.getResource(id).catch(() => null);
      return resource === null
        ? null
        : [id, { id: resource.id, resourceType: resource.resourceType, title: resource.title }] as const;
    })).then((entries) => {
      const found = entries.filter((entry) => entry !== null);
      // A batch that resolved nothing must not set state: the misses are already
      // remembered in `asked`, and a new Map here would re-render every citation
      // on screen to show exactly what it was showing.
      if (!live || found.length === 0) return;
      setFetched((previous) => new Map([...previous, ...found]));
    });
    return () => { live = false; };
  });

  const open = useCallback((target: CitationTarget): void => {
    if (target.scheme === 'external') {
      void desktopBridge().openExternal(target.url);
      return;
    }
    // An identity names somebody, not something openable, and an unknown target
    // names nothing — neither navigates, in any position.
    if (target.scheme !== 'resource') return;
    // The order is the contract. `openRail` clears the inspector deliberately,
    // so selecting the resource first would leave the rail showing its list.
    openRail('context');
    inspect({ type: 'resource', id: target.resourceId });
  }, [inspect, openRail]);

  return useMemo(() => ({ open, resolve }), [open, resolve]);
}

const EMPTY: ReadonlyMap<string, CitationResource> = new Map();
