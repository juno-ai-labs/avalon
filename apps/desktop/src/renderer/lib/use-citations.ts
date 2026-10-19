import { classifyAttachmentKind } from '@rally/contracts';
import type { CitationTarget } from '@rally/contracts/citations';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { AttachmentPreview } from '../components/attachments';
import type { CitationContext, CitationPreview, CitationResource } from '../components/markdown-citations';
import { ApiError } from './api';
import { MAX_RESOURCE_PREVIEW_WAIT_MS, readResourcePreviewText } from './resource-preview';
import { openLink } from './browser-rail-links';
import type { WorkstreamResource } from './types';

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
/**
 * Whether a failed preview read is the route's answer *about this document*,
 * and so worth remembering, as against a failure of the moment.
 *
 * The route answers 404 for a resource that is gone, 403 for one this viewer
 * may not read, and 422 for one it will not convert. Each is stable: asking
 * again on the next scroll would drive the route for as long as the reader
 * stays in the room and get the same answer every time. Everything else — a
 * dropped connection, a 5xx, a request that timed out or was rate-limited, an
 * abort — says nothing about the document, and a cached copy of it would
 * outlive the condition that caused it.
 *
 * 408 and 429 are excluded despite being 4xx: both are the server asking for
 * the request again, which is the opposite of a verdict.
 */
function documentVerdict(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

export function useCitations({ actions, loadResourceContent, onOpenPreview, onOpenResourceDetails, pinned, resources }: {
  /** The host's right-click actions for a cited resource; absent offers none. */
  actions?: CitationContext['actions'];
  /** Whether this person pinned a cited resource; absent reads as none. */
  pinned?: CitationContext['pinned'];
  /**
   * The preview route, or absent on a surface that has none. It is the same
   * read the rail's detail makes, deliberately: the embed card's excerpt and
   * the panel it opens onto must be the same text, and a second route would be
   * a second answer about one document.
   */
  loadResourceContent?: (resourceId: string, signal?: AbortSignal) => Promise<Blob>;
  onOpenPreview: (preview: AttachmentPreview) => void;
  onOpenResourceDetails: (resourceId: string, returnFocus: HTMLElement) => void;
  resources: WorkstreamResource[];
}): CitationContext & { openPreview: NonNullable<CitationContext['openPreview']> } {

  // Socket snapshots may replace the resource array even when none of the
  // citation-facing data changed. Letting that allocation rebuild `local`
  // changes every callback in this context; each mounted image card then
  // revokes its settled object URL and asks for the same preview again. Apart
  // from wasting a conversion read, the thumbnail/skeleton swap remeasures the
  // virtual row and visibly moves the feed. The fields below are the complete
  // input used to resolve, preview, and open a citation, so they are the
  // semantic identity the context actually needs.
  const resourcesIdentity = JSON.stringify(resources.map((resource) => ({
    contentAvailable: resource.contentAvailable,
    currentVersion: resource.currentVersion,
    id: resource.id,
    mimeType: resource.mimeType,
    resourceType: resource.resourceType,
    slug: resource.slug,
    title: resource.title,
  })));
  const stableResources = useMemo(() => resources, [resourcesIdentity]);

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
    const byToken = new Map<string, { citation: CitationResource; contentAvailable: boolean; version: number }>();
    for (const resource of stableResources) {
      // The version rides beside the citation rather than inside it: a chip is
      // dressed from the record's name and kind, and which revision it names is
      // the host's business, not the renderer's.
      const entry = {
        citation: {
          id: resource.id,
          resourceType: resource.resourceType,
          title: resource.title,
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        },
        contentAvailable: resource.contentAvailable === true,
        version: resource.currentVersion,
      };
      byToken.set(resource.id, entry);
      if (resource.slug) byToken.set(resource.slug, entry);
    }
    return byToken;
  }, [stableResources]);

  const resolve = useCallback(
    (token: string): CitationResource | undefined => local.get(token)?.citation,
    [local],
  );

  /**
   * One read per resource, shared by every card citing it and kept across
   * mounts.
   *
   * A transcript can cite the same document from several turns, and the reader
   * scrolls cards in and out of existence. Each read *causes* the conversion —
   * the preview route materializes the derivative inside the request — so a
   * per-card read would ask a Word file to be converted once per citation and
   * again every time the reader scrolled back. The promise is cached rather
   * than the text, so cards that mount mid-flight join the read in progress
   * instead of starting a second one.
   *
   * Reads are keyed by **id and version together**. A watched source re-ingested
   * in place keeps its id while `currentVersion` advances, so an id-only key
   * served version N's excerpt from a card the work stream had already moved to
   * N+1 — a citation substantiating a claim with the wrong revision, which is
   * the same defect the rail's own preview effect keys on `currentVersion` to
   * avoid. The new version misses the cache and reads again; the card asks for
   * it because this callback's identity changes with the resource list.
   *
   * A rejection is cached only when it is a **verdict about the document** —
   * unconvertible, gone, forbidden, retries spent. A transient failure is not:
   * `readResourcePreviewText` waits out `resource_processing` and nothing else,
   * so a dropped connection or a 5xx propagates like any other rejection, and
   * caching it would mean a card that failed once never showed a preview again
   * however long the reader stayed in the room. Those evict themselves, so the
   * next ask — a scroll back, a re-render — retries.
   */
  const reads = useRef<{
    loader: unknown;
    controller: AbortController;
    inFlight: Map<string, Promise<CitationPreview>>;
  } | null>(null);
  // Built on the first ask rather than in an effect of this hook's own, because
  // the asks come from effects *below* it: React runs a child's effect before
  // its parent's, so a card mounting in the same commit would have found an
  // uninitialized ref, been told there is no preview, and — its own effect
  // depending on a stable callback — never asked again.
  const previewReads = (loader: typeof loadResourceContent): NonNullable<typeof reads.current> => {
    const current = reads.current;
    if (current && current.loader === loader) return current;
    // A route that changed under the screen ends the reads it started, and the
    // cards still mounted ask again through the new one: their effect depends
    // on this callback, whose identity changes with the loader.
    current?.controller.abort();
    const next = { loader, controller: new AbortController(), inFlight: new Map<string, Promise<CitationPreview>>() };
    reads.current = next;
    return next;
  };
  // Unmounting leaves nothing waiting on a conversion nobody will see.
  useEffect(() => () => {
    reads.current?.controller.abort();
    reads.current = null;
  }, []);

  const preview = useCallback((resourceId: string): Promise<CitationPreview> | undefined => {
    const entry = local.get(resourceId);
    if (!loadResourceContent || !entry) return undefined;
    const state = previewReads(loadResourceContent);
    const key = `${entry.citation.id}@${entry.version}`;
    const cached = state.inFlight.get(key);
    if (cached) return cached;
    const attachmentKind = classifyAttachmentKind({
      fileName: entry.citation.title,
      mimeType: entry.citation.mimeType,
    });
    // Audio, sites, and unknown binary files have their own inspector
    // presentations and no readable excerpt to put inside a citation card.
    // Sending those bytes through the text-preview path both asks the server
    // for a conversion it cannot provide and, when the source is returned
    // directly, paints binary data as prose. The card still opens normally;
    // it simply keeps the same empty preview room as an attachment with no
    // thumbnail.
    if (attachmentKind === 'audio' || attachmentKind === 'site' || attachmentKind === 'other') return undefined;
    const read: Promise<CitationPreview> = attachmentKind === 'image'
      ? loadResourceContent(entry.citation.id, state.controller.signal)
        .then((blob) => ({ kind: 'image', blob }))
      : readResourcePreviewText(
          loadResourceContent,
          entry.citation.id,
          state.controller.signal,
          MAX_RESOURCE_PREVIEW_WAIT_MS,
        ).then((text) => ({ kind: 'text', text }));
    // Nothing else awaits this copy, and an unhandled rejection on a cached
    // promise is reported even though every consumer handles its own. The
    // eviction is guarded on identity because a later ask may already have
    // replaced this entry with a fresh read nobody would want dropped.
    read.catch((error: unknown) => {
      if (!documentVerdict(error) && state.inFlight.get(key) === read) state.inFlight.delete(key);
    });
    state.inFlight.set(key, read);
    return read;
  }, [loadResourceContent, local]);

  const attachmentPreview = useCallback((resourceId: string, returnFocus: HTMLElement): AttachmentPreview | undefined => {
    const entry = local.get(resourceId);
    if (!entry || entry.citation.resourceType === 'generated_site' || entry.citation.resourceType === 'generated_file') return undefined;
    return {
      name: entry.citation.title,
      resourceId: entry.citation.id,
      ...(entry.citation.mimeType ? { mimeType: entry.citation.mimeType } : {}),
      ...(entry.contentAvailable && loadResourceContent ? {
        loadContent: (signal?: AbortSignal) => loadResourceContent(entry.citation.id, signal),
      } : {}),
      onDetails: () => onOpenResourceDetails(entry.citation.id, returnFocus),
      returnFocus,
    };
  }, [loadResourceContent, local, onOpenResourceDetails]);

  const openPreview = useCallback((resourceId: string, returnFocus: HTMLElement, resourceIds?: readonly string[], selectedIndex?: number): void => {
    const entry = local.get(resourceId);
    if (!entry) return;
    // Generated resources open with their artifact controls, regardless of
    // file format. Attachment previews are for sources and their galleries.
    if (entry.citation.resourceType === 'generated_site' || entry.citation.resourceType === 'generated_file') {
      onOpenResourceDetails(entry.citation.id, returnFocus);
      return;
    }
    const selected = attachmentPreview(resourceId, returnFocus);
    if (!selected) return;
    const members = resourceIds?.flatMap((id) => {
      const preview = attachmentPreview(id, returnFocus);
      return preview ? [{ id, preview }] : [];
    });
    const galleryIndex = selectedIndex !== undefined && members?.[selectedIndex]?.id === resourceId ? selectedIndex : members?.findIndex(({ id }) => id === resourceId) ?? -1;
    onOpenPreview(members && galleryIndex >= 0 ? {
      ...selected, gallery: members.map(({ preview }) => preview), galleryIndex,
    } : selected);
  }, [attachmentPreview, local, onOpenPreview, onOpenResourceDetails]);

  const currentContent = useRef({ local, loadResourceContent });
  useEffect(() => { currentContent.current = { local, loadResourceContent }; }, [local, loadResourceContent]);
  const loadContent = useCallback(async (resourceId: string, signal?: AbortSignal): Promise<Blob> => {
    const current = currentContent.current;
    const entry = current.local.get(resourceId);
    if (!entry?.contentAvailable || !current.loadResourceContent || entry.citation.resourceType === 'generated_site') throw new Error('This resource has no preview available.');
    return current.loadResourceContent(entry.citation.id, signal);
  }, []);

  const open = useCallback((target: CitationTarget): void => {
    if (target.scheme === 'external') {
      void openLink(target.url);
      return;
    }
    // An identity names somebody, not something openable, and an unknown target
    // names nothing — neither navigates, in any position.
    if (target.scheme !== 'resource') return;
    openPreview(target.resourceId, document.activeElement instanceof HTMLElement ? document.activeElement : document.body);
  }, [openPreview]);

  return useMemo(() => ({ open, openPreview, preview, resolve, loadContent, ...(actions ? { actions } : {}), ...(pinned ? { pinned } : {}) }),
    [actions, open, openPreview, pinned, preview, resolve, loadContent]);
}
