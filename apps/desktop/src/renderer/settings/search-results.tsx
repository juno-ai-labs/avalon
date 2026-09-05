import { useEffect, type RefObject } from 'react';
import type { SettingSearchResult } from './registry';

export function SettingsSearchResults({ results, onSelect }: {
  results: readonly SettingSearchResult[];
  onSelect: (result: SettingSearchResult) => void;
}): React.JSX.Element {
  return (
    <nav aria-label="Settings search results" className="settings-search-results"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
        const current = buttons.findIndex((button) => button === document.activeElement);
        if (current < 0) return;
        event.preventDefault();
        buttons[(current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }}>
      <p className="sr-only" role="status">{results.length} settings found</p>
      {results.length === 0 && <p className="settings-search-empty">No settings found</p>}
      {results.map((result) => (
        <button key={result.key} type="button" data-setting-result={result.key}
          aria-label={`${result.definition.label} ${result.definition.section.replaceAll('-', ' ')}${result.instanceLabel ? ' › ' + result.instanceLabel : ''}`}
          onClick={() => onSelect(result)}>
          <strong>{result.definition.label}</strong>
          <small>{result.definition.section.replaceAll('-', ' ')}{result.instanceLabel ? ` › ${result.instanceLabel}` : ''}</small>
        </button>
      ))}
    </nav>
  );
}

/** Wait for lazy settings without mounting other panes or executing their actions. */
export function useRevealSetting(
  root: RefObject<HTMLElement | null>,
  request: SettingSearchResult | null,
): void {
  useEffect(() => {
    const container = root.current;
    if (!container || !request) return;
    let highlighted: Element | null = null;
    const reveal = (): boolean => {
      const target = Array.from(container.querySelectorAll<HTMLElement>('[data-setting-id]'))
        .find((element) => element.dataset.settingId === (request.definition.entryPoint ?? request.definition.id)
          && (!request.instanceId || element.dataset.settingInstance === request.instanceId));
      if (!target) return false;
      highlighted = target.closest('.settings-preference-row, .settings-pane-heading, .settings-theme-card, .settings-app-icon-card, article, tr') ?? target;
      highlighted.classList.add('settings-search-highlight');
      target.scrollIntoView?.({ block: 'center', behavior: 'auto' });
      target.focus({ preventScroll: true });
      return true;
    };
    const observer = new MutationObserver(() => {
      if (reveal()) observer.disconnect();
    });
    if (!reveal()) observer.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      highlighted?.classList.remove('settings-search-highlight');
    };
  }, [root, request]);
}
