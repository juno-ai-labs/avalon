import { ErrorNotice } from './primitives';
import { Globe2, X } from 'lucide-react';
import { useRef } from 'react';
import {
  EmbeddedBrowserNavigation,
  EmbeddedBrowserTabs,
  focusAddress,
  useEmbeddedBrowser,
  useEmbeddedBrowserPlacement,
  useEmbeddedBrowserShortcuts,
} from './embedded-browser-view';
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
  const surfaceRef = useRef<HTMLElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  // Scoped to the rail, which holds focus when it opens, so ⌘W and ⌘T
  // elsewhere stay Rally's.
  useEmbeddedBrowserShortcuts({ state, command, addressRef, scope: surfaceRef, onCloseLast: onClose });
  useEmbeddedBrowserPlacement(pageRef, !leaving && error === null && active !== undefined && active.url !== 'about:blank');

  return (
    <RailSurface className="embedded-browser-rail" label="Browser" leaving={leaving} onClose={onClose}
      onResize={onResize} resizeLabel="Resize browser" surfaceRef={surfaceRef} width={width}>
      <div className="embedded-browser-controls">
        <div className="embedded-browser-chrome window-no-drag">
          <EmbeddedBrowserTabs command={command} onCloseLast={onClose} onNewTab={() => void command({ action: 'open' }).then(() => focusAddress(addressRef))} state={state} />
          <IconButton label="Close browser" onClick={onClose}><X size={17} /></IconButton>
        </div>
        <EmbeddedBrowserNavigation active={active} addressRef={addressRef} className="window-no-drag" command={command} />
      </div>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <div className="embedded-browser-page" ref={pageRef}>
        {active?.url === 'about:blank' && <div className="embedded-browser-start">
          <Globe2 aria-hidden="true" size={24} />
          <p>Enter a website address to browse here</p>
        </div>}
      </div>
    </RailSurface>
  );
}
