import { useEffect, useMemo, useState } from 'react';
import { desktopBridge } from '../lib/platform';
import { Button } from '../components/primitives';

/**
 * The whole contents of the deep-link failure window.
 *
 * There is no dialog element here and no overlay: the window *is* the modal, so
 * the card fills it and the only chrome around it is the operating system's.
 * That is also why the message is read from main rather than passed in props —
 * this tree is the root of its own renderer and has no session, no workspace and
 * no socket above it, which is what lets the window open over a signed-out or
 * still-booting application without waiting for either.
 */
export function DeepLinkErrorScreen(): React.JSX.Element {
  const bridge = useMemo(() => desktopBridge(), []);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let pushed = false;
    // Subscribe before reading, and let a push win over the read. Main holds the
    // message, so a second failure arriving while this window is already open
    // replaces the text in place, and the read covers the first one — which was
    // set before this renderer existed to be told about it. But the read is a
    // snapshot taken when the invoke was served: if a newer failure lands while
    // it is still in flight, letting it settle would put the older link's
    // message back on screen and leave it there, blaming the window on a link
    // the person has already dealt with.
    const unsubscribe = bridge.onDeepLinkErrorChanged((next) => {
      if (cancelled) return;
      pushed = true;
      setMessage(next);
    });
    void bridge.getDeepLinkError()
      .then((current) => {
        if (!cancelled && !pushed) setMessage(current);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  return (
    <main className="deep-link-error-window" role="alertdialog" aria-labelledby="deep-link-error-title">
      <div className="deep-link-error-card">
        <h1 className="deep-link-error-title" id="deep-link-error-title">Rally could not open that link</h1>
        {/* Empty only in the instant between mount and the read returning. The
            window is already on screen by then, so a title with nothing under it
            is better than a spinner that flashes and is gone. */}
        <p className="deep-link-error-copy">{message}</p>
      </div>
      <div className="deep-link-error-actions">
        <Button
          autoFocus
          className="button-primary"
          onClick={() => void bridge.dismissDeepLinkError().catch(() => window.close())}
        >
          Continue
        </Button>
      </div>
    </main>
  );
}
