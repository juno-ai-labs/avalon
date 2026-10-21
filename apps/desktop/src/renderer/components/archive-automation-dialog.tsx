import { useState } from 'react';
import { Button, ErrorNotice, Modal } from './primitives';

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
      setError(failure instanceof Error ? failure.message : 'The Sidekick could not be archived.');
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
            Archive
          </Button>
        </>
      )}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      open={target !== null}
      title={target?.status === 'draft' ? 'Archive draft' : 'Archive Sidekick'}
    >
      <p className="modal-copy">
        {target?.status === 'draft' ? (
          <>
            <strong>{target.name}</strong> will be removed from your Sidekicks. Its
            conversation will remain stored but will no longer be viewable. Rally does
            not offer a way to unarchive Sidekicks yet.
          </>
        ) : (
          <>
            <strong>{target?.name}</strong> will be removed from your Sidekicks and its
            schedules will stop. Its conversation and run history will remain stored but
            will no longer be viewable. Rally does not offer a way to unarchive Sidekicks yet.
          </>
        )}
      </p>
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </Modal>
  );
}
