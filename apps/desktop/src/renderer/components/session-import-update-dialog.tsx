import { useEffect, useRef, useState } from 'react';
import type { SessionImportPreview } from '@rally/contracts';
import type { RallyApi } from '../lib/api';
import { desktopBridge } from '../lib/platform';
import { Button, InlineError, Modal } from './primitives';
import { claudeCodeSessionOption } from './session-import-picker-labels';

export interface ImportedSource {
  provider: 'chatgpt' | 'claude' | 'claude_code';
  sessionId: string;
  url: string | null;
}

export function SessionImportUpdateDialog({ api, open, onClose, source, workstreamId }: {
  api: RallyApi;
  open: boolean;
  onClose: () => void;
  source: ImportedSource;
  workstreamId: string;
}): React.JSX.Element {
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; project: string; updatedAt: number }>>([]);
  const [claudeSessions, setClaudeSessions] = useState<Array<{ id: string; kind: 'chat' | 'cowork'; title: string; updatedAt: number; sourceSessionId: string }>>([]);
  const [claudeSessionsLoaded, setClaudeSessionsLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [fileText, setFileText] = useState('');
  const [pendingPreview, setPendingPreview] = useState<SessionImportPreview | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const readRevision = useRef(0);
  const selectedClaudeSession = claudeSessions.find((session) => session.id === selectedId);

  useEffect(() => {
    if (!open || source.provider !== 'claude_code' || !window.rally) return;
    let active = true;
    void desktopBridge().listLocalClaudeCodeSessions().then((items) => {
      if (!active) return;
      setSessions(items);
      const match = items.find((item) => item.id.endsWith(`/${source.sessionId}.jsonl`));
      if (match) setSelectedId((current) => current.startsWith('cowork:') ? current : match.id);
    }).catch((error: unknown) => {
      if (active) setFailure(error instanceof Error ? error.message : 'Local sessions could not be listed. Choose the JSONL file instead.');
    });
    return () => { active = false; };
  }, [open, source.provider, source.sessionId]);

  useEffect(() => {
    if (!open || !window.rally || source.url || (source.provider !== 'claude' && source.provider !== 'claude_code')) return;
    let active = true;
    const refresh = (): void => {
      void desktopBridge().listLocalClaudeSessions().then((items) => {
        if (!active) return;
        const matching = items.filter((item) => (source.provider === 'claude' ? item.kind === 'chat' : item.kind === 'cowork'));
        setClaudeSessions(matching);
        setClaudeSessionsLoaded(true);
        const match = matching.find((item) => item.sourceSessionId === source.sessionId);
        if (match) setSelectedId(match.id);
      }).catch(() => { if (active) setClaudeSessionsLoaded(true); });
    };
    refresh();
    const unsubscribe = desktopBridge().onApplicationForegroundChanged((foregrounded) => {
      if (foregrounded) refresh();
    });
    return () => { active = false; unsubscribe(); };
  }, [open, source.provider, source.sessionId, source.url]);

  const sourceChanged = (): void => {
    setPendingPreview(null);
    setRequestId(crypto.randomUUID());
    setFailure(null);
  };
  const submit = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setFailure(null);
    try {
      let preview = pendingPreview;
      if (!preview) {
        const text = selectedId && selectedClaudeSession
          ? (await desktopBridge().readLocalClaudeSession(selectedId)).text
          : source.provider === 'claude_code' && selectedId
            ? await desktopBridge().readLocalClaudeCodeSession(selectedId) : fileText;
        const input = source.url
          ? { kind: 'link' as const, url: source.url }
          : { kind: 'export' as const, provider: source.provider, text };
        preview = await api.previewSessionImport(input);
        if (preview.source.provider !== source.provider || preview.source.sessionId !== source.sessionId) {
          throw new Error('Choose the original source conversation for this channel.');
        }
        setPendingPreview(preview);
      }
      await api.updateImportedSession(workstreamId, preview, requestId);
      setPendingPreview(null);
      setRequestId(crypto.randomUUID());
      onClose();
    } catch (error) {
      setFailure(error instanceof Error && /not saved on this Mac/.test(error.message)
        ? 'This conversation is not saved on this Mac. Open it in Claude, then try again.'
        : error instanceof Error && error.message.trim() ? error.message : 'The source could not be updated.');
    } finally {
      setSaving(false);
    }
  };

  const canSubmit = Boolean(source.url || selectedClaudeSession
    || (source.provider === 'claude_code' && (selectedId || fileText)));
  return <Modal
    footer={<>
      <Button disabled={saving} onClick={onClose}>Cancel</Button>
      <Button className="button-primary" disabled={saving || !canSubmit} onClick={() => void submit()}>
        {saving ? 'Importing…' : 'Import updates'}
      </Button>
    </>}
    onOpenChange={(next) => { if (!next && !saving) onClose(); }}
    open={open}
    title="Import source updates"
  >
    {source.url ? <p>Read the shared conversation again and add new messages to this channel.</p> : <>
      {claudeSessions.length > 0 && <label className="form-field">
        <span>Conversation</span>
        <select aria-label="Conversation" className="session-import-select" disabled={saving} title={selectedClaudeSession?.title} onChange={(event) => {
          setSelectedId(event.target.value);
          setFileText('');
          sourceChanged();
        }} value={selectedClaudeSession ? selectedId : ''}>
          <option value="">Select the source conversation</option>
          {claudeSessions.map((session) => <option key={session.id} title={session.title} value={session.id}>{claudeCodeSessionOption(session, claudeSessions)}</option>)}
        </select>
      </label>}
      {source.provider === 'claude' && claudeSessionsLoaded && claudeSessions.length === 0
        && <p>Open the source conversation in Claude, then return to Rally to refresh this list.</p>}
      {source.provider === 'claude_code' && sessions.length > 0 && !selectedClaudeSession && <label className="form-field">
        <span>Conversation</span>
        <select aria-label="Conversation" className="session-import-select" disabled={saving} title={sessions.find((session) => session.id === selectedId)?.title} onChange={(event) => {
          setSelectedId(event.target.value);
          setFileText('');
          sourceChanged();
        }} value={selectedId}>
          <option value="">Select a local conversation</option>
          {sessions.map((session) => <option key={session.id} title={session.title} value={session.id}>{claudeCodeSessionOption(session, sessions)}</option>)}
        </select>
      </label>}
      {source.provider === 'claude_code' && <label className="form-field">
        <span>Or choose the conversation file</span>
        <input accept=".jsonl,.json,application/json"
          disabled={saving} onChange={(event) => {
            const file = event.target.files?.[0];
            const revision = ++readRevision.current;
            setSelectedId('');
            setFileText('');
            sourceChanged();
            if (!file) return;
            void file.text().then((text) => {
              if (revision !== readRevision.current) return;
              setFileText(text);
            }).catch((error: unknown) => {
              if (revision === readRevision.current) setFailure(error instanceof Error ? error.message : 'The file could not be read.');
            });
          }} type="file" />
      </label>}
    </>}
    {failure && <InlineError>{failure}</InlineError>}
  </Modal>;
}
