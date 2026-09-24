import { ArrowLeft, ArrowRight, Globe2, Plus, RotateCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EmbeddedBrowserBounds, EmbeddedBrowserCommand, EmbeddedBrowserState } from '../../common/embedded-browser';
import { desktopBridge } from '../lib/platform';
import { IconButton } from './primitives';
import { RailSurface } from './rail-surface';

const emptyState: EmbeddedBrowserState = { tabs: [], activeTabId: null };

export function EmbeddedBrowserRail({
  leaving = false,
  onClose,
  onResize,
  width,
}: {
  leaving?: boolean;
  onClose: () => void;
  onResize: (width: number) => void;
  width: number;
}): React.JSX.Element {
  const bridge = desktopBridge();
  const [state, setState] = useState<EmbeddedBrowserState>(emptyState);
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);

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
    return () => {
      live = false;
      unsubscribe();
      void bridge.setEmbeddedBrowserVisible(false);
    };
  }, [bridge, command]);

  useEffect(() => {
    setAddress(active?.url === 'about:blank' ? '' : active?.url ?? '');
  }, [active?.id, active?.url]);

  useEffect(() => {
    const page = pageRef.current;
    if (!page || leaving) {
      void bridge.setEmbeddedBrowserVisible(false);
      return;
    }
    const update = (): void => {
      const occluded = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"]')]
        .some((overlay) => !overlay.contains(page) && overlay.getAttribute('data-state') !== 'closed');
      const rect = page.getBoundingClientRect();
      const bounds: EmbeddedBrowserBounds = occluded || error !== null || active?.url === 'about:blank'
        ? { x: 0, y: 0, width: 0, height: 0 }
        : {
          x: Math.round(Math.max(0, rect.left)),
          y: Math.round(Math.max(0, rect.top)),
          width: Math.max(0, Math.round(Math.min(rect.right, window.innerWidth) - Math.max(0, rect.left))),
          height: Math.max(0, Math.round(Math.min(rect.bottom, window.innerHeight) - Math.max(0, rect.top))),
        };
      void bridge.setEmbeddedBrowserBounds(bounds);
      void bridge.setEmbeddedBrowserVisible(!occluded && error === null && active?.url !== 'about:blank');
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
  }, [active?.url, bridge, error, leaving]);

  const navigate = (raw: string): void => {
    const value = raw.trim();
    if (!value) return;
    const url = /^https?:\/\//iu.test(value) ? value : `https://${value}`;
    void command({ action: 'navigate', url });
  };

  return (
    <RailSurface className="embedded-browser-rail" label="Browser" leaving={leaving} onClose={onClose}
      onResize={onResize} resizeLabel="Resize browser" scrimLabel="Close browser" width={width}>
      <div className="embedded-browser-chrome window-no-drag">
        <div className="embedded-browser-tabs" role="tablist" aria-label="Browser tabs">
          {state.tabs.map((tab) => <div className="embedded-browser-tab" key={tab.id}>
            <button aria-selected={tab.id === state.activeTabId} className="embedded-browser-tab-select"
              onClick={() => void command({ action: 'select', tabId: tab.id })} role="tab" title={tab.title} type="button">
              <Globe2 aria-hidden="true" size={14} />
              <span>{tab.title}</span>
            </button>
            <IconButton label={`Close ${tab.title}`} onClick={() => void command({ action: 'close', tabId: tab.id })}>
              <X size={13} />
            </IconButton>
          </div>)}
        </div>
        <IconButton label="New browser tab" onClick={() => void command({ action: 'open' })}><Plus size={16} /></IconButton>
        <IconButton label="Close browser" onClick={onClose}><X size={17} /></IconButton>
      </div>
      <div className="embedded-browser-toolbar window-no-drag">
        <IconButton disabled={!active?.canGoBack} label="Back" onClick={() => void command({ action: 'back' })}><ArrowLeft size={16} /></IconButton>
        <IconButton disabled={!active?.canGoForward} label="Forward" onClick={() => void command({ action: 'forward' })}><ArrowRight size={16} /></IconButton>
        <IconButton disabled={!active} label="Reload" onClick={() => void command({ action: 'reload' })}><RotateCw size={15} /></IconButton>
        <form onSubmit={(event) => { event.preventDefault(); navigate(address); }}>
          <label className="sr-only" htmlFor="embedded-browser-address">Website address</label>
          <input autoComplete="off" id="embedded-browser-address" onChange={(event) => setAddress(event.target.value)}
            placeholder="Enter website address" spellCheck={false} value={address} />
        </form>
      </div>
      {error && <div className="embedded-browser-error" role="alert">{error}</div>}
      <div className="embedded-browser-page" ref={pageRef}>
        {active?.url === 'about:blank' && <div className="embedded-browser-start">
          <Globe2 aria-hidden="true" size={24} />
          <p>Enter a website address to browse here</p>
          <div>
            <button onClick={() => navigate('https://chatgpt.com/')} type="button">ChatGPT</button>
            <button onClick={() => navigate('https://claude.ai/')} type="button">Claude</button>
          </div>
        </div>}
      </div>
    </RailSurface>
  );
}
