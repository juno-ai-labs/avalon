import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { File, Link, MessageSquare, Search, Shapes } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { SearchCategory, SearchRequest, SearchResult } from '@rally/contracts/search';
import { isComposingKeyEvent } from '../lib/ime';
import { formatRelative } from '../lib/format';

const TABS: Array<{ id: SearchCategory; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'messages', label: 'Messages' },
  { id: 'links', label: 'Links' }, { id: 'artifacts', label: 'Artifacts' },
  { id: 'files', label: 'Files' },
];
const ICONS = { messages: MessageSquare, links: Link, artifacts: Shapes, files: File };

interface SearchModalProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  search: (request: SearchRequest, signal: AbortSignal) => Promise<{ results: SearchResult[] }>;
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
  const [settledQuery, setSettledQuery] = useState('');
  useEffect(() => {
    // Same typing delay as the conversation resource picker.
    const timer = window.setTimeout(() => setSettledQuery(normalized), 250);
    return () => window.clearTimeout(timer);
  }, [normalized]);
  const response = useQuery({
    queryKey: ['workspace-search', workspaceId, category, settledQuery],
    queryFn: ({ signal }) => search({ query: settledQuery, category }, signal),
    enabled: open && settledQuery.length > 0 && settledQuery === normalized,
    // A search result must be reauthorized when this modal opens again.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const results = open && normalized && settledQuery === normalized && !response.isFetching && !response.isError ? response.data?.results ?? [] : [];
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
            onChange={(event) => { setQuery(event.currentTarget.value); setSelected(0); }}
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
            onClick={() => { setCategory(tab.id); setSelected(0); input.current?.focus(); }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const next = (index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
              setCategory(TABS[next]!.id); setSelected(0);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
            }}>{tab.label}</button>)}
        </div>
        <div className="rally-search-results" ref={list} id={listId} role="listbox" aria-label="Results" aria-busy={response.isFetching}>
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
        {results.length === 0 && <div className="rally-search-state" role="status">
          {!normalized ? 'Search messages, links, artifacts, and files'
            : (response.isFetching || settledQuery !== normalized) ? 'Searching…'
            : response.isError ? 'Search could not be completed. Please try again.' : 'No results'}
        </div>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
