import { useRef } from 'react';

import { Button, Modal } from './primitives';

export interface AcknowledgedError {
  title: string;
  copy: string;
}

/**
 * A failure that interrupts navigation belongs over the surface, never inside
 * it. The explicit acknowledgement keeps an error from becoming a persistent
 * row in a sidebar and gives focus one predictable place to land.
 */
export function AcknowledgedErrorDialog({
  error,
  onAcknowledge,
}: {
  error: AcknowledgedError | null;
  onAcknowledge: () => void;
}): React.JSX.Element {
  const acknowledgeRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      footer={<Button onClick={onAcknowledge} ref={acknowledgeRef}>OK</Button>}
      initialFocusRef={acknowledgeRef}
      onOpenChange={(open) => { if (!open) onAcknowledge(); }}
      open={error !== null}
      title={error?.title ?? 'That could not be updated'}
    >
      {error && <p className="modal-copy">{error.copy}</p>}
    </Modal>
  );
}
