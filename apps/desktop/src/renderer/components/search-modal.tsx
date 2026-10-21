import { ErrorNotice } from './primitives';
import { startPerfTrace, type PerfTrace } from '../lib/perf-trace';
import * as Dialog from '@radix-ui/react-dialog';
import { useInfiniteQuery } from '@tanstack/react-query';
import { File, Link, MessageSquare, Search, Shapes } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { SearchCategory, SearchRequest, SearchResponse, SearchResult } from '@rally/contracts/search';
import type { SpaceColorKey, SpaceIconKey, WorkstreamAppearance } from '@rally/contracts';
import { SpaceIcon } from '@rally/ui/components/space-icon';
import { WorkstreamMark } from '@rally/ui/components/workstream-glyph';
import { Button } from './primitives';
import { RelativeTime } from './relative-time';
import { ApiError } from '../lib/api';
import { isComposingKeyEvent } from '../lib/ime';

/**
 * A Channel, Breakout or Space the reader can open, matched by name in the
 * modal itself and drawn with its own mark in its own colour.
 */
export type SearchPlace =
  // `substreamId` is the conversation the Channel opens on for this reader (its sidebar row's).
  | { kind: 'channel'; id: string; name: string; substreamId?: string | undefined; appearance?: WorkstreamAppearance | undefined }
  // A Breakout is listed with the Channels. Without a look of its own it wears its Channel's.
  | { kind: 'breakout'; id: string; channelId: string; channelName: string; name: string;
    appearance?: WorkstreamAppearance | undefined; channelAppearance?: WorkstreamAppearance | undefined }
  | { kind: 'space'; id: string; name: string; iconKey: SpaceIconKey; colorKey: SpaceColorKey };

const placeKey = (place: SearchPlace) => place.kind === 'breakout' ? `breakout:${place.channelId}/${place.id}` : `${place.kind}:${place.id}`;

function PlaceIcon({ place }: { place: SearchPlace }): React.JSX.Element {
  if (place.kind === 'space') return <SpaceIcon size={18} space={place} />;
  // A look of its own resolves its unset parts from its own id; borrowing the
  // Channel's resolves them from the Channel's, so the two marks match.
  if (place.kind === 'breakout' && !place.appearance) {
    return <WorkstreamMark appearance={place.channelAppearance} id={place.channelId} size={18} />;
  }
  return <WorkstreamMark appearance={place.appearance} id={place.id} size={18} />;
}

const placeSource = (place: SearchPlace) => place.kind === 'space' ? 'Channel'
  : place.kind === 'breakout' ? `Breakout in ${place.channelName}` : 'Thread';
type PlaceTab = 'channels' | 'spaces';
type SearchTab = SearchCategory | PlaceTab;
const isPlaceTab = (tab: SearchTab): tab is PlaceTab => tab === 'channels' || tab === 'spaces';
const CONTENT_TABS: Array<{ id: SearchTab; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'messages', label: 'Messages' },
  { id: 'links', label: 'Links' }, { id: 'artifacts', label: 'Artifacts' },
  { id: 'files', label: 'Files' }, { id: 'channels', label: 'Threads' },
];
const SPACES_TAB = { id: 'spaces', label: 'Channels' } as const;
// The 360px body minus 16px padding, divided by a 52px two-line row plus 2px
// gap. The list is the whole body until a pagination footer takes part of it.
const SEARCH_VISIBLE_PAGE_SIZE = Math.ceil((360 - 16) / (52 + 2));
/**
 * How long a settled query's pages are reused before the Worker is asked
 * again: 30 seconds, set by the team on 2026-09-11.
 *
 * The repeats this catches are the ones a reader makes without meaning to —
 * backspacing over a term and typing it back, moving across the tabs and
 * returning to All, closing the modal and reopening it on the same words. Each
 * of those was a fresh Turbopuffer page and a fresh projection read for a list
 * the reader had just been looking at.
 *
 * What it costs is the freshness of an already-shown result. A search is
 * authorized per candidate through the projected decision, so a page served
 * from here is one nobody re-admitted: for up to 30 seconds a reader can be
 * shown an excerpt from a conversation whose access was revoked in between, and
 * the route's post-search membership check does not run either. Acting on the
 * row is still admitted at that moment — opening a message hydrates its
 * canonical transcript and a file goes through `/search/resources/:id/preview`,
 * both of which re-check — so the window exposes the excerpt already on screen,
 * not the content behind it. A link row is the exception: opening one hands
 * `location.url` to the browser and asks nobody, and that URL is never rendered
 * — the row shows the excerpt and the source label — so it is content behind
 * the row, and this window lengthens the reach of a revoked one by up to 30
 * seconds. Clicking a rendered row has never been re-checked, so closing that
 * needs an endpoint that does not exist and would change every path rather than
 * the cached one; it is recorded in `docs/text-search.md` instead of half-done
 * here. A new term, a departing session (`queryClient.clear()`) and a different
 * workspace or member (this component is keyed by both) all leave the window
 * rather than extend it.
 */
const SEARCH_RESULT_CACHE_MS = 30_000;
/**
 * Characters a query needs before the modal searches anything, on every tab:
 * 3, set by the team on 2026-10-05. Shorter queries match nearly everything,
 * and on the content tabs each one is a Worker round trip nobody reads.
 */
const SEARCH_MIN_CHARACTERS = 3;
/** A page, stamped with the moment the Worker admitted it. */
interface AdmittedSearchPage extends SearchResponse { admittedAt: number }
const ICONS = { messages: MessageSquare, links: Link, artifacts: Shapes, files: File };

interface SearchModalProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  search: (request: SearchRequest, signal: AbortSignal) => Promise<SearchResponse>;
  onSelect: (result: SearchResult) => void;
  /**
   * The Channels and Spaces the window already holds; their tabs match names
   * here and never ask the Worker. Without `spaces` (Spaces off) there is no
   * Spaces tab.
   */
  channels?: readonly SearchPlace[];
  spaces?: readonly SearchPlace[] | undefined;
  onSelectPlace: (place: SearchPlace) => void;
}

/**
 * Where the query first appears in a name, ignoring case, as a span of the
 * name itself. Each window of the original is lowered and compared, rather
 * than finding the query in the lowered name: lowering can change a string's
 * length (`İ` becomes two code units), and an index into the lowered copy
 * would then highlight the wrong letters.
 */
function nameMatch(name: string, query: string): { start: number; end: number } | null {
  // `toLowerCase`, not `toLocaleLowerCase`: under a Turkish locale the latter
  // lowers `I` to dotless `ı`, and "pricing" would stop matching "Pricing".
  const needle = query.toLowerCase();
  for (let start = 0; start + query.length <= name.length; start += 1) {
    if (name.slice(start, start + query.length).toLowerCase() === needle) return { start, end: start + query.length };
  }
  return null;
}

/** Places whose name holds the query, in the order given. */
function matchPlaces(places: readonly SearchPlace[], query: string): SearchPlace[] {
  return places.filter((place) => nameMatch(place.name, query));
}

function HighlightedName({ name, query }: { name: string; query: string }): React.JSX.Element {
  const match = nameMatch(name, query);
  if (!match) return <>{name}</>;
  return <>{name.slice(0, match.start)}<strong>{name.slice(match.start, match.end)}</strong>{name.slice(match.end)}</>;
}

function HighlightedExcerpt({ result }: { result: SearchResult }): React.JSX.Element {
  let cursor = 0;
  const fragments = result.highlights.flatMap((range) => {
    // Treat snippets as plain text; never insert provider-controlled markup.
    if (range.start < cursor || range.end < range.start || range.end > result.excerpt.length) return [];
    const before = result.excerpt.slice(cursor, range.start);
    cursor = range.end;
    return [before, <strong key={`${range.start}:${range.end}`}>{result.excerpt.slice(range.start, range.end)}</strong>];
  });
  return <>{fragments}{result.excerpt.slice(cursor)}</>;
}

export function SearchModal({ workspaceId, open, onOpenChange, search, onSelect, channels = [], spaces, onSelectPlace }: SearchModalProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<SearchTab>('all');
  const tabs = spaces ? [...CONTENT_TABS, SPACES_TAB] : CONTENT_TABS;
  // A Spaces tab left selected after Spaces turned off falls back to All.
  const activeTab: SearchTab = tabs.some((candidate) => candidate.id === tab) ? tab : 'all';
  const placeTab = isPlaceTab(activeTab) ? activeTab : null;
  // The Worker's category; a place tab never asks it, so this value is unused there.
  const category: SearchCategory = isPlaceTab(activeTab) ? 'all' : activeTab;
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const normalized = query.trim();
  // Counted in characters, not UTF-16 units, so three ideographs or emoji count as three.
  const searchable = [...normalized].length >= SEARCH_MIN_CHARACTERS;
  const trace = useRef<PerfTrace | null>(null);
  const traceTotals = useRef({ request: 0, scope: 0, retrieval: 0, hydration: 0, server: 0 });
  const inputAt = useRef<number | null>(null);
  const beginSearch = () => {
    trace.current?.end({ outcome: 'superseded' });
    trace.current = null;
    inputAt.current = performance.now();
    traceTotals.current = { request: 0, scope: 0, retrieval: 0, hydration: 0, server: 0 };
  };
  useEffect(() => {
    if (!open) { trace.current?.end({ outcome: 'closed' }); trace.current = null; inputAt.current = null; }
  }, [open]);
  const traceWorkspace = useRef(workspaceId);
  useEffect(() => {
    if (traceWorkspace.current !== workspaceId) {
      trace.current?.end({ outcome: 'superseded' }); trace.current = null; inputAt.current = null;
      traceWorkspace.current = workspaceId;
    }
  }, [workspaceId]);
  useEffect(() => () => { trace.current?.end({ outcome: 'unmounted' }); trace.current = null; }, []);
  const [settledQuery, setSettledQuery] = useState('');
  useEffect(() => {
    // Same typing delay as the conversation resource picker.
    const timer = window.setTimeout(() => setSettledQuery(normalized), 250);
    return () => window.clearTimeout(timer);
  }, [normalized]);
  const response = useInfiniteQuery({
    queryKey: ['workspace-search', workspaceId, category, settledQuery],
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: AdmittedSearchPage) => page.nextCursor ?? undefined,
    queryFn: async ({ signal, pageParam }): Promise<AdmittedSearchPage> => {
      if (!pageParam && !trace.current) {
        trace.current = startPerfTrace('workspace_search', { startedAt: inputAt.current ?? performance.now() });
      }
      const currentTrace = trace.current;
      const totals = traceTotals.current;
      if (!pageParam) currentTrace?.mark('search_debounce');
      const run = () => search({ query: settledQuery, category, pageSize: SEARCH_VISIBLE_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}) }, signal);
      const started = performance.now();
      const page = await (currentTrace ? currentTrace.step('search_request', run) : run()).finally(() => {
        totals.request += performance.now() - started;
        currentTrace?.annotate({ searchRequestMs: totals.request });
      });
      if (page.timings) {
        totals.scope += page.timings.scopeMs;
        totals.retrieval += page.timings.retrievalMs;
        totals.hydration += page.timings.hydrationMs;
        totals.server += page.timings.serverMs;
        currentTrace?.annotate({ searchScopeMs: totals.scope, searchRetrievalMs: totals.retrieval,
          searchHydrationMs: totals.hydration, searchServerMs: totals.server });
      }
      return { ...page, admittedAt: Date.now() };
    },
    enabled: open && !placeTab && searchable && settledQuery === normalized,
    // Reopening on the same words repaints the last pages rather than
    // reauthorizing them; after the window one keystroke's worth of results is
    // read again.
    //
    // The deadline is absolute, anchored on the first page. Every page of one
    // infinite query shares a single `dataUpdatedAt`, so a plain number would
    // let each continuation renew the freshness of every page before it: scroll
    // for two minutes and the first page — admitted at the start, never
    // readmitted since — would still repaint, which is not the 30 seconds the
    // team agreed to. It is expressed relative to `dataUpdatedAt` because
    // `timeUntilStale` adds it to that, so this resolves to the one instant
    // `admittedAt + SEARCH_RESULT_CACHE_MS`, and goes negative — stale — for a
    // continuation fetched after the window had already closed.
    staleTime: (query) => {
      const admittedAt = query.state.data?.pages[0]?.admittedAt;
      return admittedAt === undefined ? 0 : admittedAt + SEARCH_RESULT_CACHE_MS - query.state.dataUpdatedAt;
    },
    // Matches so the pages a changed term left behind are still there when the
    // reader backspaces onto them; a first page older than the window is kept
    // but stale, so reuse re-reads it rather than repainting it.
    gcTime: SEARCH_RESULT_CACHE_MS,
    retry: false,
    // Focus changes must not restart candidate pages while the reader is choosing.
    refetchOnWindowFocus: false,
  });
  const continuationFailed = response.isFetchNextPageError
    && (!(response.error instanceof ApiError) || response.error.status >= 500);
  // A place tab lists its own kind; All puts every matching place above the
  // content results, which arrive later and so never push a place down. No
  // cap: how many is the team's number to set.
  const places = !open || !searchable ? []
    : placeTab ? matchPlaces(placeTab === 'channels' ? channels : spaces ?? [], normalized)
    : activeTab === 'all' ? matchPlaces([...channels, ...spaces ?? []], normalized) : [];
  const results = open && !placeTab && searchable && settledQuery === normalized && (!response.isFetching || response.isFetchingNextPage) && (!response.isError || continuationFailed)
    ? [...new Map((response.data?.pages.flatMap((page) => page.results) ?? []).map((result) => [result.id, result])).values()] : [];
  useEffect(() => {
    if (!open || placeTab || !searchable || settledQuery !== normalized || response.isFetching || !response.isFetched) return;
    // Keep time-to-results open across explicit continuation, including the user's wait.
    if (!response.isError && results.length === 0 && response.hasNextPage) return;
    const current = trace.current;
    if (!current) return;
    // Two animation frames put the completion boundary after the committed result paint.
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      current.mark('search_render');
      current.end({ outcome: response.isError ? 'failed' : 'completed' });
      if (trace.current === current) trace.current = null;
    }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [open, placeTab, searchable, normalized, settledQuery, response.isFetching, response.isFetched, response.isError, results.length, response.hasNextPage]);
  const canContinue = open && !placeTab && searchable && settledQuery === normalized && response.hasNextPage && (!response.isError || continuationFailed);
  const loadMore = () => {
    if (canContinue && !response.isFetching) void response.fetchNextPage({ cancelRefetch: false });
  };
  // The next page loads as the end of the list comes into view, and again
  // whenever a page lands without filling the viewport; a failed continuation
  // waits for the explicit retry so a broken cursor cannot loop.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !canContinue || continuationFailed || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    }, { root: list.current });
    observer.observe(target);
    return () => observer.disconnect();
  }, [canContinue, continuationFailed, results.length]);
  const rowCount = places.length + results.length;
  const active = Math.min(selected, Math.max(0, rowCount - 1));
  // Also when the footer opens or closes: it takes its room from the list, and
  // the state that opens it is one the reader reaches without moving the
  // highlight — the last row is what asks for the next page — so `active` alone
  // would leave that row clipped, or gone, under the footer that just arrived.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, response.isFetchingNextPage, continuationFailed]);
  const choose = (index: number) => {
    if (index < places.length) {
      const place = places[index];
      if (!place) return;
      onSelectPlace(place);
    } else {
      const result = results[index - places.length];
      if (!result) return;
      onSelect(result);
    }
    onOpenChange(false);
  };
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="rally-search-overlay" />
      <Dialog.Content className="rally-search-modal" aria-describedby={undefined}
        onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); input.current?.select(); }}
        onEscapeKeyDown={(event) => { if (isComposingKeyEvent(event)) event.preventDefault(); }}>
        <Dialog.Title className="sr-only">Search organization</Dialog.Title>
        <div className="rally-search-input-row">
          <Search aria-hidden="true" size={16} />
          <input ref={input} aria-label="Search organization" role="combobox" aria-autocomplete="list"
            aria-expanded={rowCount > 0} aria-controls={listId}
            aria-activedescendant={rowCount > active ? `${listId}-${active}` : undefined}
            placeholder="Search" value={query} autoComplete="off" spellCheck={false}
            onChange={(event) => { beginSearch(); setQuery(event.currentTarget.value); setSelected(0); }}
            onKeyDown={(event) => {
              if (isComposingKeyEvent(event.nativeEvent)) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                // Reaching the last row by keyboard is the same signal as scrolling to it.
                if (event.key === 'ArrowDown' && active >= rowCount - 1) loadMore();
                setSelected(Math.max(0, Math.min(rowCount - 1, active + (event.key === 'ArrowDown' ? 1 : -1))));
              } else if (event.key === 'Enter') { event.preventDefault(); choose(active); }
              else if ((event.metaKey || event.ctrlKey) && /^[1-9]$/u.test(event.key)) {
                event.preventDefault(); choose(Number(event.key) - 1);
              }
            }} />
        </div>
        <div className="rally-search-tabs" role="tablist" aria-label="Filter results">
          {tabs.map((candidate, index) => <button key={candidate.id} type="button" role="tab"
            aria-selected={activeTab === candidate.id} tabIndex={activeTab === candidate.id ? 0 : -1}
            onClick={() => { beginSearch(); setTab(candidate.id); setSelected(0); input.current?.focus(); }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const next = (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
              beginSearch(); setTab(tabs[next]!.id); setSelected(0);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
            }}>{candidate.label}</button>)}
        </div>
        {/* One fixed-height body: the list and the pagination footer divide it, so
            no state either of them enters can resize the modal around the reader. */}
        <div className="rally-search-body">
          {/* The scroller holds the listbox and, after it, the status lines: a
              listbox may hold only options, so a status beside the places sits
              outside it while still reading as the next line beneath them. */}
          <div className="rally-search-results" ref={list}
            onScroll={(event) => {
              const element = event.currentTarget;
              if (element.scrollTop + element.clientHeight >= element.scrollHeight - 1) loadMore();
            }}>
            <div className="rally-search-options" id={listId} role="listbox" aria-label="Results" aria-busy={response.isFetching}>
              {places.map((place, index) => {
                return <div key={placeKey(place)} id={`${listId}-${index}`} role="option" aria-selected={index === active}
                  className="rally-search-result" onMouseMove={() => setSelected(index)}
                  onMouseDown={(event) => event.preventDefault()} onClick={() => choose(index)}>
                  <span className={`rally-search-result-icon is-${place.kind}`}><PlaceIcon place={place} /></span>
                  <div className="rally-search-result-copy">
                    <div className="rally-search-result-excerpt"><HighlightedName name={place.name} query={normalized} /></div>
                    <div className="rally-search-result-source">{placeSource(place)}</div>
                  </div>
                </div>;
              })}
              {results.map((result, resultIndex) => {
                const Icon = ICONS[result.category];
                const index = places.length + resultIndex;
                return <div key={result.id} id={`${listId}-${index}`} role="option" aria-selected={index === active}
                  className="rally-search-result" onMouseMove={() => setSelected(index)}
                  onMouseDown={(event) => event.preventDefault()} onClick={() => choose(index)}>
                  <span className={`rally-search-result-icon is-${result.category}`}><Icon size={18} aria-hidden="true" /></span>
                  <div className="rally-search-result-copy">
                    <div className="rally-search-result-excerpt"><HighlightedExcerpt result={result} /></div>
                    <div className="rally-search-result-source">{result.sourceLabel || result.title}{result.occurredAt && <> · <RelativeTime value={result.occurredAt} /></>}</div>
                  </div>
                </div>;
              })}
            </div>
            {/* Places answer at once; say what the content search is doing beneath them. */}
            {places.length > 0 && !placeTab && results.length === 0 && (response.isFetching || settledQuery !== normalized
              ? <div className="rally-search-pending" role="status">Searching…</div>
              : response.isError && !continuationFailed
              ? null
              : null)}
            {canContinue && <div ref={sentinel} className="rally-search-sentinel" aria-hidden="true" />}
          </div>
          {canContinue && (continuationFailed || response.isFetchingNextPage) && <div className="rally-search-footer" role="status">
            {continuationFailed
              ? <><ErrorNotice occurrence={response.error}>More results could not be loaded. Please try again.</ErrorNotice>
                <Button type="button" onClick={loadMore} onMouseDown={(event) => event.preventDefault()}>Retry loading more results</Button></>
              : <div>Loading more…</div>}
          </div>}
        </div>
        {rowCount === 0 && !(canContinue && continuationFailed) && <div className="rally-search-state" role="status">
          {!searchable ? 'What are you looking for?'
            : placeTab ? 'No results'
            : (response.isFetching || settledQuery !== normalized || canContinue) ? 'Searching…'
            : response.isError ? null : 'No results'}
        </div>}
        {!placeTab && searchable && response.isError && !continuationFailed && <>
          <ErrorNotice occurrence={response.error}>Search could not be completed. Please try again.</ErrorNotice>
          <Button onClick={() => void response.refetch()}>Retry search</Button>
        </>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
