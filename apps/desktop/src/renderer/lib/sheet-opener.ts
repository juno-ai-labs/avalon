import { useCallback, useEffect, useRef } from 'react';

/**
 * Where focus goes when a sheet opened from a pane header closes: back to the
 * control that opened it, or, when that is gone or was never focused (a
 * tapped button in WebKit takes no focus; a skeleton's mark is replaced when
 * its pane loads), to the first visible control matching `fallback`.
 *
 * Returns the function that opens the sheet. It reads the opener before the
 * sheet opens, since opening makes the pane inert and that drops its focus.
 */
export function useSheetOpener(open: boolean, setOpen: (open: boolean) => void, fallback: string): () => void {
  const opened = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open || !opened.current) return;
    opened.current = false;
    const held = opener.current;
    opener.current = null;
    const target = held?.isConnected && !held.closest('[hidden]')
      ? held
      : document.querySelector<HTMLElement>(fallback);
    target?.focus();
  }, [fallback, open]);
  return useCallback(() => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    opened.current = true;
    setOpen(true);
  }, [setOpen]);
}
