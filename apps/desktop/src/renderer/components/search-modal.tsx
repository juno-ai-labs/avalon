import { startPerfTrace, type PerfTrace } from '../lib/perf-trace';
import * as Dialog from '@radix-ui/react-dialog';
import { useInfiniteQuery } from '@tanstack/react-query';
import { File, Link, MessageSquare, Search, Shapes } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { SearchCategory, SearchRequest, SearchResponse, SearchResult } from '@rally/contracts/search';
import { Button } from './primitives';
import { ApiError } from '../lib/api';
import { isComposingKeyEvent } from '../lib/ime';
import { formatRelative } from '../lib/format';

const TABS: Array<{ id: SearchCategory; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'messages', label: 'Messages' },
  { id: 'links', label: 'Links' }, { id: 'artifacts', label: 'Artifacts' },
  { id: 'files', label: 'Files' },
];
// 360px list minus 16px padding, divided by a 52px two-line row plus 2px gap.
const SEARCH_VISIBLE_PAGE_SIZE = Math.ceil((360 - 16) / (52 + 2));
const ICONS = { messages: MessageSquare, links: Link, artifacts: Shapes, files: File };

interface SearchModalProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  search: (request: SearchRequest, signal: AbortSignal) => Promise<SearchResponse>;
  onSelect: (result: SearchResult) => void;
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

export function SearchModal({ workspaceId, open, onOpenChange, search, onSelect }: SearchModalProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SearchCategory>('all');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const normalized = query.trim();
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
    getNextPageParam: (page: SearchResponse) => page.nextCursor ?? undefined,
    queryFn: async ({ signal, pageParam }): Promise<SearchResponse> => {
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
      return page;
    },
    enabled: open && settledQuery.length > 0 && settledQuery === normalized,
    // A search result must be reauthorized when this modal opens again.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const incomplete = settledQuery === normalized && response.data?.pages.some((page) => page.complete === false);
  const continuationFailed = response.isFetchNextPageError
    && (!(response.error instanceof ApiError) || response.error.status >= 500);
  const results = open && normalized && settledQuery === normalized && (!response.isFetching || response.isFetchingNextPage) && (!response.isError || continuationFailed)
    ? [...new Map((response.data?.pages.flatMap((page) => page.results) ?? []).map((result) => [result.id, result])).values()] : [];
  useEffect(() => {
    if (!open || !normalized || settledQuery !== normalized || response.isFetching || !response.isFetched || (results.length === 0 && response.hasNextPage && !response.isError)) return;
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
  }, [open, normalized, settledQuery, response.isFetching, response.isFetched, response.isError, results.length, response.hasNextPage]);
  const loadMore = () => {
    if (open && settledQuery === normalized && response.hasNextPage && !response.isFetching && (!response.isError || continuationFailed)) void response.fetchNextPage({ cancelRefetch: false });
  };
  useEffect(() => {
    // A fully rejected candidate page is not an empty search. Follow its cursor
    // until a current authorized result is visible or the provider is exhausted.
    if (open && settledQuery === normalized && response.hasNextPage && !response.isFetching
      && !response.isError && results.length === 0) void response.fetchNextPage();
  }, [open, settledQuery, normalized, response.hasNextPage, response.isFetching, response.isError, response.fetchNextPage, results.length, response.data?.pages.length]);
  const active = Math.min(selected, Math.max(0, results.length - 1));
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const choose = (index: number) => {
    const result = results[index];
    if (!result) return;
    onSelect(result);
    onOpenChange(false);
  };
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="rally-search-overlay" />
      <Dialog.Content className="rally-search-modal" aria-describedby={undefined}
        onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); input.current?.select(); }}
        onEscapeKeyDown={(event) => { if (isComposingKeyEvent(event)) event.preventDefault(); }}>
        <Dialog.Title className="sr-only">Search workspace</Dialog.Title>
        <div className="rally-search-input-row">
          <Search aria-hidden="true" size={16} />
          <input ref={input} aria-label="Search workspace" role="combobox" aria-autocomplete="list"
            aria-expanded={results.length > 0} aria-controls={listId}
            aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
            placeholder="Search" value={query} autoComplete="off" spellCheck={false}
            onChange={(event) => { beginSearch(); setQuery(event.currentTarget.value); setSelected(0); }}
            onKeyDown={(event) => {
              if (isComposingKeyEvent(event.nativeEvent)) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setSelected(Math.max(0, Math.min(results.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))));
              } else if (event.key === 'Enter') { event.preventDefault(); choose(active); }
              else if ((event.metaKey || event.ctrlKey) && /^[1-9]$/u.test(event.key)) {
                event.preventDefault(); choose(Number(event.key) - 1);
              }
            }} />
        </div>
        <div className="rally-search-tabs" role="tablist" aria-label="Filter results">
          {TABS.map((tab, index) => <button key={tab.id} type="button" role="tab"
            aria-selected={category === tab.id} tabIndex={category === tab.id ? 0 : -1}
            onClick={() => { beginSearch(); setCategory(tab.id); setSelected(0); input.current?.focus(); }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const next = (index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
              beginSearch(); setCategory(TABS[next]!.id); setSelected(0);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
            }}>{tab.label}</button>)}
        </div>
        <div className="rally-search-results" ref={list} id={listId} role="listbox" aria-label="Results" aria-busy={response.isFetching}
          onScroll={(event) => {
            const element = event.currentTarget;
            if (element.scrollTop + element.clientHeight >= element.scrollHeight - 1) loadMore();
          }}>
          {results.map((result, index) => {
            const Icon = ICONS[result.category];
            return <div key={result.id} id={`${listId}-${index}`} role="option" aria-selected={index === active}
              className="rally-search-result" onMouseMove={() => setSelected(index)}
              onMouseDown={(event) => event.preventDefault()} onClick={() => choose(index)}>
              <span className={`rally-search-result-icon is-${result.category}`}><Icon size={18} aria-hidden="true" /></span>
              <div className="rally-search-result-copy">
                <div className="rally-search-result-excerpt"><HighlightedExcerpt result={result} /></div>
                <div className="rally-search-result-source">{result.sourceLabel || result.title}{result.occurredAt && <> · {formatRelative(result.occurredAt)}</>}</div>
              </div>
              {index < 9 && <kbd aria-hidden="true">⌘{index + 1}</kbd>}
            </div>;
          })}
        </div>
        {incomplete && !response.isFetching && <div className="rally-search-footer" role="status">
          <div>Some results are unavailable.</div>
          <Button type="button" onClick={() => { void response.refetch(); }}>Retry search</Button>
        </div>}
        {settledQuery === normalized && response.hasNextPage && (!response.isError || continuationFailed) && <div className="rally-search-footer">
          {continuationFailed && <div role="status">More results could not be loaded. Please try again.</div>}
          <Button type="button" onClick={loadMore} aria-disabled={response.isFetching}
            onMouseDown={(event) => event.preventDefault()}>
            {response.isFetchingNextPage ? 'Loading more…' : continuationFailed ? 'Retry loading more results' : 'Load more results'}
          </Button>
        </div>}
        {results.length === 0 && <div className="rally-search-state" role="status">
          {!normalized ? 'Search messages, links, artifacts, and files'
            : (response.isFetching || settledQuery !== normalized) ? 'Searching…'
            : response.isError ? 'Search could not be completed. Please try again.' : response.hasNextPage ? 'More results are available' : incomplete ? 'No verified results available' : 'No results'}
        </div>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
