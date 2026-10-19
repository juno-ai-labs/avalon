import { ArrowLeft, ArrowRight, Globe2, Plus, RotateCw, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import {
  embeddedBrowserShortcut,
  type EmbeddedBrowserCommand,
  type EmbeddedBrowserState,
  type EmbeddedBrowserTab,
} from '../../common/embedded-browser';
import { desktopBridge } from '../lib/platform';
import { IconButton } from './primitives';

const emptyState: EmbeddedBrowserState = { tabs: [], activeTabId: null };

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
 * a Rally dialog or menu; it is hidden while one is open instead. Hidden keeps
 * the rectangle: main parks the page out of the window at this size, so an
 * agent driving it reads, captures and clicks the same page it did in view.
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
      void bridge.setEmbeddedBrowserBounds({
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
export function EmbeddedBrowserNavigation({ active, command, className, addressRef }: {
  active: EmbeddedBrowserTab | undefined;
  command: (input: EmbeddedBrowserCommand) => Promise<void>;
  className?: string;
  /** Lets the host focus the address field for ⌘L and a new tab. */
  addressRef?: RefObject<HTMLInputElement | null>;
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
        onFocus={(event) => event.currentTarget.select()} ref={addressRef}
        placeholder="Enter website address" spellCheck={false} value={address} />
    </form>
  </div>;
}

/**
 * Closes a tab, and hands the close to `onCloseLast` too when it is the only
 * tab: main replaces a closed last tab with a blank one, so the host closes
 * the browser rather than show it. A blank tab is left in place, since closing
 * it would only open another.
 */
function closeTab(state: EmbeddedBrowserState, tabId: string, command: (input: EmbeddedBrowserCommand) => Promise<void>,
  onCloseLast: (() => void) | undefined): void {
  const only = state.tabs.length === 1 ? state.tabs[0] : undefined;
  if (!onCloseLast || only?.id !== tabId) {
    void command({ action: 'close', tabId });
    return;
  }
  if (only.url !== 'about:blank') void command({ action: 'close', tabId });
  onCloseLast();
}

/** Focuses and selects the address field, once the host has rendered it. */
export function focusAddress(addressRef: RefObject<HTMLInputElement | null>): void {
  requestAnimationFrame(() => {
    addressRef.current?.focus();
    addressRef.current?.select();
  });
}

/**
 * The browser's keyboard shortcuts for a host's own controls. With a scope,
 * they act only while focus is inside it, so a browser in the right rail never
 * takes ⌘W or ⌘T from the rest of Rally. A shortcut pressed inside the page
 * itself is handled in main and arrives here only as a request for the address
 * field.
 */
export function useEmbeddedBrowserShortcuts({ state, command, addressRef, scope, onCloseLast, enabled = true }: {
  state: EmbeddedBrowserState;
  command: (input: EmbeddedBrowserCommand) => Promise<void>;
  addressRef: RefObject<HTMLInputElement | null>;
  scope?: RefObject<HTMLElement | null>;
  /** Called instead of closing the only tab when it is blank. */
  onCloseLast?: () => void;
  /** False while something else is driving the browser and keys must not move it. */
  enabled?: boolean;
}): void {
  const latest = useRef(state);
  latest.current = state;
  const closeLast = useRef(onCloseLast);
  closeLast.current = onCloseLast;
  useEffect(() => {
    if (!enabled) return;
    const mac = /Mac/u.test(navigator.platform);
    const onKey = (event: KeyboardEvent): void => {
      if (scope && !(scope.current?.contains(document.activeElement) ?? false)) return;
      const shortcut = embeddedBrowserShortcut({ key: event.key, code: event.code, shift: event.shiftKey, alt: event.altKey,
        control: event.ctrlKey, command: mac ? event.metaKey : event.ctrlKey });
      if (!shortcut) return;
      event.preventDefault();
      const { tabs, activeTabId } = latest.current;
      const at = tabs.findIndex((tab) => tab.id === activeTabId);
      if (shortcut.kind === 'new-tab') void command({ action: 'open' }).then(() => focusAddress(addressRef));
      else if (shortcut.kind === 'close-tab') { if (activeTabId) closeTab(latest.current, activeTabId, command, closeLast.current); }
      else if (shortcut.kind === 'focus-address') focusAddress(addressRef);
      else if (shortcut.kind === 'reload' || shortcut.kind === 'back' || shortcut.kind === 'forward') void command({ action: shortcut.kind });
      else if (shortcut.kind === 'next-tab' || shortcut.kind === 'previous-tab') {
        const next = tabs[(at + (shortcut.kind === 'next-tab' ? 1 : tabs.length - 1)) % Math.max(tabs.length, 1)];
        if (next) void command({ action: 'select', tabId: next.id });
      } else if (shortcut.kind === 'tab-at') {
        const target = shortcut.index === 'last' ? tabs.at(-1) : tabs[shortcut.index];
        if (target) void command({ action: 'select', tabId: target.id });
      }
    };
    window.addEventListener('keydown', onKey);
    const unsubscribe = desktopBridge().onEmbeddedBrowserHostRequest((request) => {
      if (request === 'focus-address') focusAddress(addressRef);
      else if (latest.current.activeTabId) closeTab(latest.current, latest.current.activeTabId, command, closeLast.current);
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      unsubscribe();
    };
  }, [addressRef, command, scope, enabled]);
}

/** A tab's leading mark: a spinner while loading, then the page's icon, then a globe. */
function TabMark({ tab }: { tab: EmbeddedBrowserTab }): React.JSX.Element {
  const [failed, setFailed] = useState<string | null>(null);
  if (tab.loading) return <span aria-hidden="true" className="embedded-browser-tab-spinner" />;
  if (tab.favicon && failed !== tab.favicon) {
    return <img alt="" aria-hidden="true" className="embedded-browser-tab-icon" onError={() => setFailed(tab.favicon)}
      referrerPolicy="no-referrer" src={tab.favicon} />;
  }
  return <Globe2 aria-hidden="true" className="embedded-browser-tab-icon" size={14} />;
}

/**
 * The tab strip shared by every browser host: the page's icon or a loading
 * spinner, its title, a close button, and a new-tab button. Tabs shrink to
 * share the strip and it scrolls to keep the active one visible. Arrow keys,
 * Home and End move between tabs and Delete closes one; a middle click closes
 * a tab and dragging reorders them. A website's popup opens as a tab too.
 */
export function EmbeddedBrowserTabs({ state, command, className, onNewTab, onCloseLast }: {
  state: EmbeddedBrowserState;
  command: (input: EmbeddedBrowserCommand) => Promise<void>;
  className?: string;
  onNewTab: () => void;
  /** Called instead of closing the only tab when it is blank. */
  onCloseLast?: () => void;
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [state.activeTabId, state.tabs.length]);

  const focusTab = (index: number): void => {
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus();
  };
  const close = (tab: EmbeddedBrowserTab): void => closeTab(state, tab.id, command, onCloseLast);

  return <div className={className ? `embedded-browser-tabstrip ${className}` : 'embedded-browser-tabstrip'}>
    <div aria-label="Browser tabs" className="embedded-browser-tabs" onDragLeave={() => setDropAt(null)} ref={listRef} role="tablist">
      {state.tabs.map((tab, index) => {
        const active = tab.id === state.activeTabId;
        const title = tab.title || 'New tab';
        return <div className="embedded-browser-tab" data-active={active || undefined} data-drop-before={dropAt === index || undefined}
          data-dragging={dragging === tab.id || undefined} draggable key={tab.id}
          onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); close(tab); } }}
          onDragEnd={() => { setDragging(null); setDropAt(null); }}
          onDragOver={(event) => {
            if (!dragging) return;
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            setDropAt(event.clientX < box.left + box.width / 2 ? index : index + 1);
          }}
          onDragStart={(event) => { setDragging(tab.id); event.dataTransfer.effectAllowed = 'move'; }}
          onDrop={(event) => {
            event.preventDefault();
            if (dragging && dropAt !== null) {
              const from = state.tabs.findIndex((candidate) => candidate.id === dragging);
              void command({ action: 'move', tabId: dragging, index: dropAt > from ? dropAt - 1 : dropAt });
            }
            setDragging(null);
            setDropAt(null);
          }}
          title={tab.url === 'about:blank' ? title : `${title}\n${tab.url}`}>
          {/* One tab stop for the strip; the arrows move between tabs, as a tablist does. */}
          <button aria-selected={active} className="embedded-browser-tab-select"
            onClick={() => void command({ action: 'select', tabId: tab.id })}
            onKeyDown={(event) => {
              const count = state.tabs.length;
              const next = event.key === 'ArrowRight' ? (index + 1) % count : event.key === 'ArrowLeft' ? (index + count - 1) % count
                : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null;
              if (next !== null) {
                event.preventDefault();
                void command({ action: 'select', tabId: state.tabs[next]!.id });
                focusTab(next);
              } else if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                close(tab);
              }
            }}
            role="tab" tabIndex={active ? 0 : -1} type="button">
            <TabMark tab={tab} />
            <span className="embedded-browser-tab-title">{title}</span>
          </button>
          <button aria-label={`Close ${title}`} className="embedded-browser-tab-close" onClick={() => close(tab)} tabIndex={-1} type="button">
            <X aria-hidden="true" size={12} strokeWidth={2.2} />
          </button>
        </div>;
      })}
    </div>
    <IconButton label="New tab" onClick={onNewTab}><Plus size={16} /></IconButton>
  </div>;
}
