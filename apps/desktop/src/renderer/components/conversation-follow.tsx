import { ArrowDown, LoaderCircle, RefreshCcw, X } from 'lucide-react';
import { Button, IconButton } from './primitives';

/** Product-neutral control shared by every ordered conversation surface. */
export function JumpToLatestButton({ onJump }: { onJump: () => void }): React.JSX.Element {
  return (
    <IconButton className="jump-bottom" label="Jump to latest" onClick={onJump} tooltipSide="top">
      <ArrowDown aria-hidden="true" size={15} />
    </IconButton>
  );
}

/**
 * What a conversation says after somebody stopped it.
 *
 * Shared by the work-stream feed and the automation builder rather than
 * imported from one screen into the other: a screen that re-exports a
 * component becomes a second import path for it, and the next reader
 * cannot tell which one is the real home.
 */
export function RunStoppedNotice({
  retrying,
  onRetry,
}: {
  retrying: boolean;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <section aria-label="Run stopped" className="run-stopped-notice" role="status">
      <span aria-hidden="true" className="run-stopped-icon"><X size={16} /></span>
      <div className="run-stopped-copy">
        <strong>Run stopped</strong>
        <p>This run was stopped by request. Its partial tool activity is no longer running.</p>
      </div>
      <Button className="button-primary" disabled={retrying} onClick={onRetry}>
        {retrying ? <LoaderCircle aria-hidden="true" className="spin" size={13} /> : <RefreshCcw aria-hidden="true" size={13} />}
        Retry
      </Button>
    </section>
  );
}
