/** Orders renderer recovery so the screen the person is looking at comes back
 * first. iOS usually kills every WebView's content process in one pass; if all
 * of them reload together, Home's full application boot competes with the one
 * document on screen.
 *
 * A visible renderer reloads at once and holds the queue until it has
 * presented. A hidden one waits until no visible recovery remains, or until it
 * is shown or needed (`wake`). */
export function recoveryOrder(yieldTurn: (run: () => void) => void = (run) => { setTimeout(run, 0); }) {
  const foreground = new Set<string>();
  const waiting = new Map<string, () => void>();
  let scheduled = false;
  const flush = () => {
    if (scheduled || foreground.size > 0 || waiting.size === 0) return;
    scheduled = true;
    // Renderers killed in the same pass report one after another. Yield once
    // so a visible renderer reported after a hidden one still goes first.
    yieldTurn(() => {
      scheduled = false;
      if (foreground.size > 0) return;
      const runs = [...waiting.values()];
      waiting.clear();
      for (const run of runs) run();
    });
  };
  return {
    /** A visible renderer is reloading now. */
    recovering(id: string) { foreground.add(id); },
    /** That renderer presented, failed or was hidden: background work may start. */
    settled(id: string) { foreground.delete(id); flush(); },
    /** A hidden renderer terminated; reload it when the foreground allows. */
    defer(id: string, reload: () => void) { waiting.set(id, reload); flush(); },
    /** The renderer is now shown or needed: reload it at once if it waits. */
    wake(id: string) {
      const reload = waiting.get(id);
      if (!reload) return;
      waiting.delete(id);
      reload();
    },
    forget(id: string) { waiting.delete(id); foreground.delete(id); flush(); },
  };
}

export const recovery = recoveryOrder();
export const HOME_RENDERER = 'web:Home';
