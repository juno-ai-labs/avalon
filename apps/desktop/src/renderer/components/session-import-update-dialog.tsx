import { useState } from 'react';
import { isBrowserConversationUrl } from '../lib/browser-conversation';
import { desktopBridge } from '../lib/platform';
import { Button, ErrorNotice, Modal } from './primitives';

export interface ImportedSource {
  provider: 'chatgpt' | 'claude' | 'claude_code';
  sessionId: string;
  url: string | null;
}

/**
 * Whether Rally can read this Channel's source again: only a conversation its
 * browser can open. Channels imported from local files before importing moved
 * to the browser have no such source.
 */
export function importedSourceUpdatable(source: ImportedSource | null | undefined): source is ImportedSource {
  return Boolean(source && isBrowserConversationUrl(source.url));
}

/**
 * Confirm reading a Channel's source conversation again.
 *
 * The read happens in the import window, on the recorded conversation, where
 * the person can see the page, sign in again if the site asks, and watch or
 * cancel the import agent; this dialog only opens it.
 */
export function SessionImportUpdateDialog({ open, onClose, source, workstreamId }: {
  open: boolean;
  onClose: () => void;
  source: ImportedSource;
  workstreamId: string;
}): React.JSX.Element {
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (opening || !source.url) return;
    setOpening(true);
    setFailure(null);
    try {
      await desktopBridge().openBrowserImport({ spaces: [], update: { workstreamId, sourceUrl: source.url } });
      onClose();
    } catch (error) {
      setFailure(error instanceof Error && error.message.trim() ? error.message : 'The import window could not open.');
    } finally {
      setOpening(false);
    }
  };

  return <Modal
    footer={<>
      <Button disabled={opening} onClick={onClose}>Cancel</Button>
      <Button className="button-primary" disabled={opening || !source.url} onClick={() => void submit()}>
        {opening ? 'Opening…' : 'Import updates'}
      </Button>
    </>}
    onOpenChange={(next) => { if (!next && !opening) onClose(); }}
    open={open}
    title="Import source updates"
  >
    <p>Read this conversation again in Rally’s browser and add what changed to this thread.</p>
    {failure && <ErrorNotice>{failure}</ErrorNotice>}
  </Modal>;
}
