import type { RallyApi } from "../lib/api";
import { useState } from 'react';
import type { SessionImportPreview } from '@rally/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAppSession } from '../lib/app-session';
import { WORKSTREAMS_QUERY_KEY } from '../lib/use-workstreams-query';
import { Button, InlineError, Modal } from './primitives';

interface SessionImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SessionImportDialog({ open, onOpenChange }: SessionImportDialogProps): React.JSX.Element {
  const { api } = useAppSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  if (!api) return <></>;
  return <SessionImportForm open={open} onOpenChange={onOpenChange} api={api} onImported={async (id) => {
    await queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
    await navigate(`/workstreams/${id}`);
  }} />;
}

export function SessionImportForm({ api, onImported, open, onOpenChange }: SessionImportDialogProps & {
  api: Pick<RallyApi, 'previewSessionImport' | 'importSession'>;
  onImported: (workstreamId: string) => Promise<void>;
}): React.JSX.Element {
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<SessionImportPreview | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    if (busy || !url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const content = preview ?? await api.previewSessionImport({ kind: 'link', url: url.trim() });
      setPreview(content);
      const id = await api.importSession(content, requestId);
      await onImported(id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The conversation could not be imported.');
    } finally { setBusy(false); }
  };
  return <>
    <Modal open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }} title="Import conversation" footer={<>
      <Button disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
      <Button type="submit" form="session-import-form" disabled={busy || !url.trim()}>{busy ? 'Working…' : 'Create a new work stream'}</Button>
    </>}>
      <p className="modal-copy">Bring in a ChatGPT or Claude conversation, including available attachments and artifact files. Imported messages keep their user and assistant roles and show who imported them.</p>
      <form id="session-import-form" className="session-import-link-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label className="form-field">Shared conversation link
          <input type="url" required value={url} disabled={busy} onChange={(event) => { setUrl(event.target.value); setPreview(null); setRequestId(crypto.randomUUID()); }} placeholder="https://claude.ai/share/…" />
        </label>
      </form>
      {error && <InlineError>{error}</InlineError>}
    </Modal>
  </>;
}
