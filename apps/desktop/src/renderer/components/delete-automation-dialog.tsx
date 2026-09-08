import { useState } from 'react';
import { Button, InlineError, Modal } from './primitives';

/**
 * The one confirmation an automation's deletion goes through.
 *
 * Deleting tombstones the automation and archives every past run, and nothing
 * brings either back, so the sidebar always asked first. The automation's own
 * page then grew a Delete item that fired the same operation from a menu with
 * no question, so the question lives here and both surfaces open it.
 */
export interface DeleteAutomationDialogProps {
  /** The automation under the question, or null when the dialog is closed. */
  target: { name: string; status: string } | null;
  onClose: () => void;
  /** Performs the deletion; a rejection is shown in the dialog, which stays open. */
  onConfirm: () => Promise<void>;
}

export function DeleteAutomationDialog({ target, onClose, onConfirm }: DeleteAutomationDialogProps): React.JSX.Element {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = (): void => {
    if (deleting) return;
    setError(null);
    onClose();
  };
  const submit = async (): Promise<void> => {
    setDeleting(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The Sidekick could not be deleted.');
    } finally {
      setDeleting(false);
    }
  };
  return (
    <Modal
      footer={(
        <>
          <Button disabled={deleting} onClick={close}>Cancel</Button>
          <Button className="button-danger" disabled={deleting} onClick={() => void submit()}>
            Delete
          </Button>
        </>
      )}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      open={target !== null}
      title={target?.status === 'draft' ? 'Delete draft' : 'Delete Sidekick'}
    >
      <p className="modal-copy">
        {target?.status === 'draft' ? (
          <>
            <strong>{target.name}</strong> and the conversation that was writing it are
            deleted for good. Rally has no way to bring a draft back.
          </>
        ) : (
          <>
            {/* What the API does, rather than the reassurance this
                said before it: deleting enqueues an archive for
                every work stream the automation's runs created, so
                the runs leave with it. */}
            <strong>{target?.name}</strong> is deleted from your Sidekicks for good.
            Every past run — and the work stream each one created — is archived with it, and
            Rally has no way to bring them back.
          </>
        )}
      </p>
      {error && <InlineError>{error}</InlineError>}
    </Modal>
  );
}
