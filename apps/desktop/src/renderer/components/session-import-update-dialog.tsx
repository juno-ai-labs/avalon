import { useEffect, useState } from 'react';
import type { SessionImportPreview } from '@rally/contracts';
import type { RallyApi } from '../lib/api';
import { desktopBridge } from '../lib/platform';
import { Button, InlineError, Modal } from './primitives';
import { isBrowserConversationUrl, readBrowserConversation } from '../lib/browser-conversation-import';

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

export function SessionImportUpdateDialog({ api, open, onClose, source, workstreamId }: {
  api: Pick<RallyApi, 'previewSessionImport' | 'updateImportedSession'>;
  open: boolean;
  onClose: () => void;
  source: ImportedSource;
  workstreamId: string;
}): React.JSX.Element {
  const [pendingPreview, setPendingPreview] = useState<SessionImportPreview | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setPendingPreview(null);
    setRequestId(crypto.randomUUID());
    setFailure(null);
  }, [open]);

  useEffect(() => {
    setPendingPreview(null);
    setRequestId(crypto.randomUUID());
    setFailure(null);
  }, [workstreamId, source.provider, source.sessionId, source.url]);

  const submit = async (): Promise<void> => {
    if (saving || !source.url) return;
    setSaving(true);
    setFailure(null);
    try {
      let preview = pendingPreview;
      if (!preview) {
        // The recorded conversation is read through the browser's account
        // partition, in the tab showing it or one opened for the read.
        const read = await readBrowserConversation(desktopBridge(), source.url, { openIfMissing: true });
        preview = await api.previewSessionImport({ kind: 'export', provider: read.provider, text: read.text, sourceUrl: source.url });
        if (preview.source.provider !== source.provider || preview.source.sessionId !== source.sessionId) {
          throw new Error('The source must match the conversation originally imported into this channel.');
        }
        setPendingPreview(preview);
      }
      await api.updateImportedSession(workstreamId, preview, requestId);
      setPendingPreview(null);
      setRequestId(crypto.randomUUID());
      onClose();
    } catch (error) {
      setFailure(error instanceof Error && error.message.trim() ? error.message : 'The source could not be updated.');
    } finally {
      setSaving(false);
    }
  };

  return <Modal
    footer={<>
      <Button disabled={saving} onClick={onClose}>Cancel</Button>
      <Button className="button-primary" disabled={saving || !source.url} onClick={() => void submit()}>
        {saving ? 'Importing…' : 'Import updates'}
      </Button>
    </>}
    onOpenChange={(next) => { if (!next && !saving) onClose(); }}
    open={open}
    title="Import source updates"
  >
    <p>Read this conversation again through Rally’s browser and add its updates to this channel.</p>
    {failure && <InlineError>{failure}</InlineError>}
  </Modal>;
}
