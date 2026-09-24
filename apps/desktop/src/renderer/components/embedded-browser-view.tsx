import { ArrowLeft, ArrowRight, Globe2, RotateCw, X } from 'lucide-react';
import { useCallback, useEffect, useId, useState, type RefObject } from 'react';
import type { EmbeddedBrowserBounds, EmbeddedBrowserCommand, EmbeddedBrowserState, EmbeddedBrowserTab } from '../../common/embedded-browser';
import { desktopBridge } from '../lib/platform';
import { IconButton } from './primitives';

const emptyState: EmbeddedBrowserState = { tabs: [], activeTabId: null };
const hidden: EmbeddedBrowserBounds = { x: 0, y: 0, width: 0, height: 0 };

/**
 * This window's browser: its tabs, the active one, and the command entry
 * point. Opens a blank tab on first use so there is always a page to address.
 */
export function useEmbeddedBrowser(): {
  state: EmbeddedBrowserState;
  active: EmbeddedBrowserTab | undefined;
  error: string | null;
  command: (input: EmbeddedBrowserCommand) => Promise<void>;
} {
  const bridge = desktopBridge();
  const [state, setState] = useState<EmbeddedBrowserState>(emptyState);
  const [error, setError] = useState<string | null>(null);

  const command = useCallback(async (input: EmbeddedBrowserCommand): Promise<void> => {
    try {
      setError(null);
      const result = await bridge.commandEmbeddedBrowser(input);
      if (result.kind === 'state') setState(result.state);
    } catch {
      setError('The browser could not complete that action. Try again.');
    }
  }, [bridge]);

  useEffect(() => {
    let live = true;
    const unsubscribe = bridge.onEmbeddedBrowserState((next) => {
      if (live) setState(next);
    });
    void bridge.getEmbeddedBrowserState().then((next) => {
      if (!live) return;
      setState(next);
      if (next.tabs.length === 0) void command({ action: 'open' });
    }).catch(() => {
      if (live) setError('The browser could not open.');
    });
    // Visibility belongs to `useEmbeddedBrowserPlacement` alone; a second
    // writer here raced its show on every remount.
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge, command]);

  return { state, active: state.tabs.find((tab) => tab.id === state.activeTabId), error, command };
}

/**
 * Keeps the native page over `pageRef`'s rectangle while `show` holds.
 *
 * The page is a native view above the renderer, so it cannot be layered under
 * a Rally dialog or menu; it is hidden while one is open instead.
 */
export function useEmbeddedBrowserPlacement(pageRef: RefObject<HTMLElement | null>, show: boolean): void {
  useEffect(() => {
    const bridge = desktopBridge();
    const page = pageRef.current;
    if (!page || !show) {
      void bridge.setEmbeddedBrowserVisible(false);
      return;
    }
    const update = (): void => {
      const occluded = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"]')]
        .some((overlay) => !overlay.contains(page) && overlay.getAttribute('data-state') !== 'closed');
      const rect = page.getBoundingClientRect();
      void bridge.setEmbeddedBrowserBounds(occluded ? hidden : {
        x: Math.round(Math.max(0, rect.left)),
        y: Math.round(Math.max(0, rect.top)),
        width: Math.max(0, Math.round(Math.min(rect.right, window.innerWidth) - Math.max(0, rect.left))),
        height: Math.max(0, Math.round(Math.min(rect.bottom, window.innerHeight) - Math.max(0, rect.top))),
      });
      void bridge.setEmbeddedBrowserVisible(!occluded);
    };
    const sizes = new ResizeObserver(update);
    sizes.observe(page);
    const overlays = new MutationObserver(update);
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'role'] });
    window.addEventListener('resize', update);
    update();
    return () => {
      sizes.disconnect();
      overlays.disconnect();
      window.removeEventListener('resize', update);
      void bridge.setEmbeddedBrowserVisible(false);
    };
  }, [pageRef, show]);
}

/** Accepts a bare host the way a browser's address field does. */
export function embeddedBrowserAddress(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  return /^https?:\/\//iu.test(value) ? value : `https://${value}`;
}

/** Back, forward, reload, and the address field for the active tab. */
export function EmbeddedBrowserNavigation({ active, command, className }: {
  active: EmbeddedBrowserTab | undefined;
  command: (input: EmbeddedBrowserCommand) => Promise<void>;
  className?: string;
}): React.JSX.Element {
  const addressId = useId();
  const [address, setAddress] = useState('');
  useEffect(() => {
    setAddress(active?.url === 'about:blank' ? '' : active?.url ?? '');
  }, [active?.id, active?.url]);
  return <div className={className ? `embedded-browser-toolbar ${className}` : 'embedded-browser-toolbar'}>
    <IconButton disabled={!active?.canGoBack} label="Back" onClick={() => void command({ action: 'back' })}><ArrowLeft size={16} /></IconButton>
    <IconButton disabled={!active?.canGoForward} label="Forward" onClick={() => void command({ action: 'forward' })}><ArrowRight size={16} /></IconButton>
    <IconButton disabled={!active || active.url === 'about:blank'} label="Reload" onClick={() => void command({ action: 'reload' })}><RotateCw size={15} /></IconButton>
    <form onSubmit={(event) => {
      event.preventDefault();
      const url = embeddedBrowserAddress(address);
      if (url) void command({ action: 'navigate', url });
    }}>
      <label className="sr-only" htmlFor={addressId}>Website address</label>
      <input autoComplete="off" id={addressId} onChange={(event) => setAddress(event.target.value)}
        placeholder="Enter website address" spellCheck={false} value={address} />
    </form>
  </div>;
}

/** The tab strip. A website's popup opens as a tab, so there may be several. */
export function EmbeddedBrowserTabs({ state, command, className }: {
  state: EmbeddedBrowserState;
  command: (input: EmbeddedBrowserCommand) => Promise<void>;
  className?: string;
}): React.JSX.Element {
  return <div aria-label="Browser tabs" className={className ? `embedded-browser-tabs ${className}` : 'embedded-browser-tabs'} role="tablist">
    {state.tabs.map((tab, index) => <div className="embedded-browser-tab" key={tab.id}>
      {/* One tab stop for the strip; the arrows move between tabs, as a tablist does. */}
      <button aria-selected={tab.id === state.activeTabId} className="embedded-browser-tab-select"
        onClick={() => void command({ action: 'select', tabId: tab.id })}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const next = (index + (event.key === 'ArrowRight' ? 1 : state.tabs.length - 1)) % state.tabs.length;
          void command({ action: 'select', tabId: state.tabs[next]!.id });
          event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}
        role="tab" tabIndex={tab.id === state.activeTabId ? 0 : -1} title={tab.title} type="button">
        <Globe2 aria-hidden="true" size={14} />
        <span>{tab.title}</span>
      </button>
      <IconButton label={`Close ${tab.title}`} onClick={() => void command({ action: 'close', tabId: tab.id })}>
        <X size={13} />
      </IconButton>
    </div>)}
  </div>;
}
