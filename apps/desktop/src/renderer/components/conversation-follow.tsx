import { ArrowDown } from 'lucide-react';
import { IconButton } from './primitives';

/** Product-neutral control shared by every ordered conversation surface. */
export function JumpToLatestButton({ onJump }: { onJump: () => void }): React.JSX.Element {
  return (
    <IconButton className="jump-bottom" label="Jump to latest" onClick={onJump} tooltipSide="top">
      <ArrowDown aria-hidden="true" size={15} />
    </IconButton>
  );
}
