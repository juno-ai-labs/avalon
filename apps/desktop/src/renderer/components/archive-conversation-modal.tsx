import { Button, InlineError, Modal } from './primitives';

export function ArchiveConversationModal({ target, pending, error, onClose, onConfirm }: {
  target: { title: string; noun: 'thread' | 'breakout' } | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  return <Modal
    open={target !== null}
    title={`Archive ${target?.noun ?? 'thread'}`}
    onOpenChange={(open) => { if (!open && !pending) onClose(); }}
    footer={<>
      <Button disabled={pending} onClick={onClose}>Cancel</Button>
      <Button className="button-danger" disabled={pending} onClick={onConfirm}>Archive</Button>
    </>}
  >
    <p className="modal-copy"><strong>{target?.title}</strong> leaves the sidebar for everyone in it, and stops accepting messages.</p>
    {error && <InlineError>{error}</InlineError>}
  </Modal>;
}
