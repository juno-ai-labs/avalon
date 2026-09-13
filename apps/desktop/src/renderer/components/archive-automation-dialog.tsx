import { useState } from 'react';
import { Button, InlineError, Modal } from './primitives';

export interface ArchiveAutomationDialogProps {
  /** The Sidekick or draft under the question, or null when the dialog is closed. */
  target: { name: string; status: string } | null;
  onClose: () => void;
  /** Performs the archive (or draft deletion); a rejection stays in the dialog. */
  onConfirm: () => Promise<void>;
}

export function ArchiveAutomationDialog({ target, onClose, onConfirm }: ArchiveAutomationDialogProps): React.JSX.Element {
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDraft = target?.status === 'draft';
  const close = (): void => {
    if (archiving) return;
    setError(null);
    onClose();
  };
  const submit = async (): Promise<void> => {
    setArchiving(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error
        ? failure.message
        : isDraft ? 'The draft could not be deleted.' : 'The Sidekick could not be archived.');
    } finally {
      setArchiving(false);
    }
  };
  return (
    <Modal
      footer={(
        <>
          <Button disabled={archiving} onClick={close}>Cancel</Button>
          <Button className="button-danger" disabled={archiving} onClick={() => void submit()}>
            {isDraft ? 'Delete' : 'Archive'}
          </Button>
        </>
      )}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      open={target !== null}
      title={isDraft ? 'Delete draft' : 'Archive Sidekick'}
    >
      <p className="modal-copy">
        {isDraft ? (
          <>
            <strong>{target.name}</strong> and the conversation that was writing it are
            deleted for good. Rally has no way to bring a draft back.
          </>
        ) : (
          <>
            <strong>{target?.name}</strong> will be removed from your Sidekicks and its
            schedules will stop. Its conversation and past runs will be kept. Rally does
            not offer a way to unarchive Sidekicks yet.
          </>
        )}
      </p>
      {error && <InlineError>{error}</InlineError>}
    </Modal>
  );
}
