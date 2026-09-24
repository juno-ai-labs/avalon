import { Globe2, Plus, X } from 'lucide-react';
import { useRef } from 'react';
import { EmbeddedBrowserNavigation, EmbeddedBrowserTabs, embeddedBrowserAddress, useEmbeddedBrowser, useEmbeddedBrowserPlacement } from './embedded-browser-view';
import { IconButton } from './primitives';
import { RailSurface } from './rail-surface';

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
  const { state, active, error, command } = useEmbeddedBrowser();
  const pageRef = useRef<HTMLDivElement>(null);
  useEmbeddedBrowserPlacement(pageRef, !leaving && error === null && active !== undefined && active.url !== 'about:blank');

  const navigate = (raw: string): void => {
    const url = embeddedBrowserAddress(raw);
    if (url) void command({ action: 'navigate', url });
  };

  return (
    <RailSurface className="embedded-browser-rail" label="Browser" leaving={leaving} onClose={onClose}
      onResize={onResize} resizeLabel="Resize browser" scrimLabel="Close browser" width={width}>
      <div className="embedded-browser-chrome window-no-drag">
        <EmbeddedBrowserTabs command={command} state={state} />
        <IconButton label="New browser tab" onClick={() => void command({ action: 'open' })}><Plus size={16} /></IconButton>
        <IconButton label="Close browser" onClick={onClose}><X size={17} /></IconButton>
      </div>
      <EmbeddedBrowserNavigation active={active} className="window-no-drag" command={command} />
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
