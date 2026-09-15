import type { RallyApi } from "../lib/api";
import type { z } from "zod";
import { useState } from 'react';
import type { SessionImportPreview, SessionImportPreviewRequestSchema } from '@rally/contracts';
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
  const [provider, setProvider] = useState<'chatgpt' | 'claude'>('claude');
  const [preview, setPreview] = useState<SessionImportPreview | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async (input: z.infer<typeof SessionImportPreviewRequestSchema>): Promise<void> => {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(await api.previewSessionImport(input));
      setRequestId(crypto.randomUUID());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The conversation could not be read.');
    } finally { setBusy(false); }
  };
  const submit = async (): Promise<void> => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const id = await api.importSession(preview, requestId);
      await onImported(id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The conversation could not be imported.');
    } finally { setBusy(false); }
  };
  return <>
    <Modal open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }} title="Import conversation" footer={<>
      <Button disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
      <Button disabled={busy || !preview?.title.trim()} onClick={() => void submit()}>{busy ? 'Working…' : 'Import into new work stream'}</Button>
    </>}>
      <p className="modal-copy">Bring in the text from a ChatGPT or Claude conversation. Imported messages keep their user and assistant roles and show who imported them.</p>
      <form className="session-import-link-form" onSubmit={(event) => { event.preventDefault(); void load({ kind: 'link', url }); }}>
        <label className="form-field">Shared conversation link
          <input type="url" required value={url} disabled={busy} onChange={(event) => { setUrl(event.target.value); setPreview(null); }} placeholder="https://claude.ai/share/…" />
        </label>
        <Button type="submit" disabled={busy || !url.trim()}>Read conversation</Button>
      </form>
      <details className="session-import-export"><summary>Import an export file instead</summary>
      <p className="modal-copy">For a Claude Code session or a link that requires login, choose a JSON or JSONL export.</p>
      <label className="form-field">Export source
        <select value={provider} disabled={busy} onChange={(event) => setProvider(event.target.value === 'chatgpt' ? 'chatgpt' : 'claude')}>
          <option value="claude">Claude / Claude Code</option><option value="chatgpt">ChatGPT</option>
        </select>
      </label>
      <label className="form-field">Conversation export
        <input type="file" accept=".json,.jsonl,application/json" disabled={busy} onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void file.text().then((text) => load({ kind: 'export', provider, text })).catch(() => setError('The file could not be read.'));
          event.target.value = '';
        }} />
      </label>
      </details>
      {preview && <div className="session-import-preview">
        <label className="form-field">Work stream title<input value={preview.title} maxLength={180} onChange={(event) => {
          setPreview({ ...preview, title: event.target.value }); setRequestId(crypto.randomUUID());
        }} /></label>
        <p>{preview.content.messages.length} messages · Only visible conversation text</p>
        <ol>{preview.content.messages.map((message, index) => <li key={index}>
          <strong>{message.role === 'user' ? 'User' : preview.source.provider === 'chatgpt' ? 'ChatGPT' : 'Claude'}</strong>
          <p>{message.text}</p>
        </li>)}</ol>
      </div>}
      {error && <InlineError>{error}</InlineError>}
    </Modal>
  </>;
}
