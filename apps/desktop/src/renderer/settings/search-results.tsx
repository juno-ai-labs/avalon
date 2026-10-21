import { useEffect, type RefObject } from 'react';
import type { DesktopSettingsSection } from '../../common/settings';
import type { SettingSearchResult } from './registry';

/* Typed against the section list rather than inferred, so adding a section
   fails the build here instead of shipping a result whose page name is
   `undefined`. */
const sectionLabels: Record<DesktopSettingsSection, string> = { notifications: 'Notifications', account: 'Account', workspace: 'Organization', 'internet-access': 'Security', connections: 'Connections', connection: 'Connections', application: 'Application' };

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
      <p className="sr-only" role="status">{results.length} {results.length === 1 ? 'setting' : 'settings'} found</p>
      {results.length === 0 && <p className="settings-search-empty">No settings found</p>}
      {results.map((result) => (
        <button key={result.key} type="button" data-setting-result={result.key}
          aria-label={`${result.definition.label} ${sectionLabels[result.definition.section]}${result.instanceLabel ? ' › ' + result.instanceLabel : ''}`}
          onClick={() => onSelect(result)}>
          <strong>{result.definition.label}</strong>
          <small>{sectionLabels[result.definition.section]}{result.instanceLabel ? ` › ${result.instanceLabel}` : ''}</small>
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
    let cancelled = false;
    let revealing = false;
    const reveal = (): boolean => {
      if (cancelled) return true;
      const target = Array.from(container.querySelectorAll<HTMLElement>('[data-setting-id]'))
        .find((element) => element.dataset.settingId === (request.definition.entryPoint ?? request.definition.id)
          && (!request.instanceId || element.dataset.settingInstance === request.instanceId));
      // Failed destination reads already render their error; stop waiting until
      // the reader explicitly retries the search instead of retaining a scan.
      if (!target) return Boolean(document.querySelector('[data-error-notice]'));
      highlighted = target.closest('.settings-preference-row, .settings-pane-heading, .settings-theme-card, .settings-app-icon-card, article, td') ?? target;
      highlighted.classList.add('settings-search-highlight');
      target.scrollIntoView?.({ block: 'center', behavior: 'auto' });
      // A focusable descendant of a button can still activate it on keyup.
      // Reveal action labels visually, but never transfer keyboard activation.
      revealing = true;
      if (!target.closest('button, a, [role="button"]')) target.focus({ preventScroll: true });
      revealing = false;
      return true;
    };
    const observer = new MutationObserver(() => {
      if (reveal()) observer.disconnect();
    });
    const cancel = (): void => {
      if (revealing) return;
      cancelled = true;
      observer.disconnect();
      highlighted?.classList.remove('settings-search-highlight');
    };
    if (!reveal()) observer.observe(container, { childList: true, subtree: true });
    // A late query must not take focus back after the user moves on. No arbitrary
    // timeout: the destination may legitimately load slowly or display an error.
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    document.addEventListener('focusin', cancel, true);
    return () => {
      cancel();
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
      document.removeEventListener('focusin', cancel, true);
    };
  }, [root, request]);
}
