import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { useSheetOpener } from './sheet-opener';

/** A pane header's menu mark, the sheet it opens, and another mark the pane may swap in. */
function Harness({ swap = false }: { swap?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  // The pane loads while the sheet is open, and its header replaces the skeleton's.
  const [loaded, setLoaded] = useState(false);
  const openSheet = useSheetOpener(open, (next) => { setOpen(next); if (next && swap) setLoaded(true); }, '.mark:not([hidden] *) button');
  return <>
    <div className="mark">
      {!loaded && <button onClick={openSheet} type="button">Open from skeleton</button>}
    </div>
    <div className="mark"><button type="button">Open from header</button></div>
    {open && <button onClick={() => setOpen(false)} type="button">Close</button>}
  </>;
}

describe('useSheetOpener', () => {
  it('hands focus back to the control that opened the sheet', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open from skeleton' });
    opener.focus();
    fireEvent.click(opener);
    screen.getByRole('button', { name: 'Close' }).focus();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(opener).toHaveFocus();
  });

  it('falls back to the visible mark when the opener was replaced while the sheet was open', () => {
    render(<Harness swap />);
    const opener = screen.getByRole('button', { name: 'Open from skeleton' });
    opener.focus();
    fireEvent.click(opener);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.getByRole('button', { name: 'Open from header' })).toHaveFocus();
  });

  it('falls back to the visible mark when nothing held focus as the sheet opened, as a tap in WebKit leaves it', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open from skeleton' }));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.getByRole('button', { name: 'Open from skeleton' })).toHaveFocus();
  });
});
