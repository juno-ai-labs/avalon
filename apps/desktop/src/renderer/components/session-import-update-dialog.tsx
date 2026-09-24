import { useEffect, useRef, useState } from 'react';
import type { SessionImportPreview } from '@rally/contracts';
import type { RallyApi } from '../lib/api';
import { desktopBridge } from '../lib/platform';
import { Button, InlineError, Modal } from './primitives';
import { isChatGptConversationUrl, readChatGptBrowserConversation } from '../lib/chatgpt-browser-import';

export interface ImportedSource {
  provider: 'chatgpt' | 'claude' | 'claude_code' | 'codex';
  sessionId: string;
  url: string | null;
}

export function SessionImportUpdateDialog({ api, open, onClose, source, workstreamId }: {
  api: Pick<RallyApi, 'previewSessionImport' | 'updateImportedSession'>;
  open: boolean;
  onClose: () => void;
  source: ImportedSource;
  workstreamId: string;
}): React.JSX.Element {
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; project: string; updatedAt: number }>>([]);
  const [claudeSessions, setClaudeSessions] = useState<Array<{ id: string; kind: 'chat' | 'cowork'; title: string; updatedAt: number; sourceSessionId: string }>>([]);
  const [codexSessions, setCodexSessions] = useState<Array<{ id: string; title: string; updatedAt: number }>>([]);
  const [claudeSessionsLoaded, setClaudeSessionsLoaded] = useState(false);
  const [fileText, setFileText] = useState('');
  const [useFile, setUseFile] = useState(false);
  const [pendingPreview, setPendingPreview] = useState<SessionImportPreview | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const readRevision = useRef(0);
  const sourceClaudeSession = claudeSessions.find((session) => session.sourceSessionId === source.sessionId);
  const sourceCodeSession = sessions.find((session) => session.id.endsWith(`/${source.sessionId}.jsonl`));
  const sourceCodexSession = codexSessions.find((session) => session.id === source.sessionId);
  const sourceSession = source.provider === 'claude' ? sourceClaudeSession
    : source.provider === 'claude_code' ? sourceClaudeSession ?? sourceCodeSession
      : source.provider === 'codex' ? sourceCodexSession : undefined;

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

  useEffect(() => {
    if (!open || source.provider !== 'claude_code' || !window.rally) return;
    let active = true;
    void desktopBridge().listLocalClaudeCodeSessions().then((items) => {
      if (!active) return;
      setSessions(items);
    }).catch((error: unknown) => {
      if (active) setFailure(error instanceof Error ? error.message : 'Local sessions could not be listed. Choose the JSONL file instead.');
    });
    return () => { active = false; };
  }, [open, source.provider, source.sessionId]);

  useEffect(() => {
    if (!open || source.provider !== 'codex' || !window.rally) return;
    let active = true;
    void desktopBridge().listLocalCodexSessions().then((items) => {
      if (active) setCodexSessions(items);
    }).catch(() => { if (active) setCodexSessions([]); });
    const unsubscribe = desktopBridge().onApplicationForegroundChanged((foregrounded) => {
      if (foregrounded) void desktopBridge().listLocalCodexSessions().then((items) => {
        if (active) setCodexSessions(items);
      }).catch(() => { if (active) setCodexSessions([]); });
    });
    return () => { active = false; unsubscribe(); };
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
        const text = source.provider === 'claude_code' && useFile ? fileText
          : sourceClaudeSession ? (await desktopBridge().readLocalClaudeSession(sourceClaudeSession.id)).text
            : sourceCodeSession ? await desktopBridge().readLocalClaudeCodeSession(sourceCodeSession.id)
              : sourceCodexSession ? await desktopBridge().readLocalCodexSession(sourceCodexSession.id) : '';
        const browserText = isChatGptConversationUrl(source.url)
          ? await readChatGptBrowserConversation(desktopBridge(), source.url!) : null;
        const input = browserText
          ? { kind: 'export' as const, provider: 'chatgpt' as const, text: browserText, sourceUrl: source.url! }
          : source.url ? { kind: 'link' as const, url: source.url }
          : { kind: 'export' as const, provider: source.provider, text };
        preview = await api.previewSessionImport(input);
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
      setFailure(error instanceof Error && /not saved on this Mac/.test(error.message)
        ? 'This conversation is not saved on this Mac. Open it in Claude, then try again.'
        : error instanceof Error && error.message.trim() ? error.message : 'The source could not be updated.');
    } finally {
      setSaving(false);
    }
  };

  const canSubmit = Boolean(source.url || (source.provider === 'claude' && sourceClaudeSession)
    || (source.provider === 'claude_code' && (useFile ? fileText : sourceSession))
    || (source.provider === 'codex' && sourceCodexSession));
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
    {source.url ? <p>{isChatGptConversationUrl(source.url)
      ? 'Read this ChatGPT conversation again in Rally’s browser and add its updates to this channel.'
      : 'Read the shared conversation again and add new messages to this channel.'}</p> : <>
      {sourceSession && <div className="form-field">
        <span>Conversation</span>
        <div className="session-import-source-title" title={sourceSession.title}>{sourceSession.title}</div>
      </div>}
      {source.provider === 'claude' && claudeSessionsLoaded && !sourceClaudeSession
        && <p>Open the source conversation in Claude, then return to Rally to refresh it.</p>}
      {source.provider === 'codex' && !sourceCodexSession
        && <p>This Codex task is unavailable on this Mac.</p>}
      {source.provider === 'claude_code' && <label className="form-field">
        <span>{sourceSession ? 'Or choose the conversation file' : 'Choose the conversation file'}</span>
        <input accept=".jsonl,.json,application/json"
          disabled={saving} onChange={(event) => {
            const file = event.target.files?.[0];
            const revision = ++readRevision.current;
            setUseFile(Boolean(file));
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
