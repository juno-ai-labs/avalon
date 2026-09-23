import type { SpaceSummary } from '@rally/contracts';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';

import { Button, DropdownSelect, InlineError, Modal, Tip } from './primitives';
import { desktopBridge } from '../lib/platform';
import { claudeCodeSessionOption } from './session-import-picker-labels';

type CreationKind = 'channel' | 'import' | 'space';
type ImportSource = 'link' | 'claude_local' | 'claude_code';
export type ChannelImportInput = {
  clientMessageId: string;
  name: string;
  spaceId: string;
  source: { kind: 'link'; url: string } | { kind: 'export'; provider: 'claude' | 'claude_code'; text: string };
};

export function claudeExportRecords(text: string): { records: unknown[]; titles: string[] } {
  const data: unknown = JSON.parse(text);
  const records = Array.isArray(data) ? data : Array.isArray((data as { conversations?: unknown } | null)?.conversations)
    ? (data as { conversations: unknown[] }).conversations : [data];
  if (!records.length || !records.every((record) => record !== null && typeof record === 'object'
    && Array.isArray((record as { chat_messages?: unknown }).chat_messages))) {
    throw new Error('Choose conversations.json from a Claude data export.');
  }
  return { records, titles: records.map((record, index) => {
    const value = record as { name?: unknown; title?: unknown };
    return (typeof value.name === 'string' && value.name.trim()) || (typeof value.title === 'string' && value.title.trim()) || `Conversation ${index + 1}`;
  }) };
}

/** The one creation launcher shared by the expanded sidebar and compact rail. */
export function NewWorkstreamMenu({
  children,
  canCreateSpace = true,
  spaces = [],
  onCreateChannel,
  onCreateSpace,
  onImportChannel,
  tooltipLabel = 'New channel',
  tooltipSide = 'bottom',
}: {
  children: ReactElement;
  canCreateSpace?: boolean;
  tooltipSide?: 'bottom' | 'right';
  spaces?: SpaceSummary[];
  onCreateChannel: (input: { name: string; spaceId: string }) => Promise<void>;
  onCreateSpace: (name: string) => Promise<void>;
  onImportChannel: (input: ChannelImportInput) => Promise<void>;
  tooltipLabel?: string;
}): React.JSX.Element {
  const formId = useId();
  const [kind, setKind] = useState<CreationKind | null>(null);
  const [spaceId, setSpaceId] = useState('');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [importSource, setImportSource] = useState<ImportSource>('link');
  const [fileText, setFileText] = useState('');
  const [localSessions, setLocalSessions] = useState<Array<{ id: string; title: string; project: string; updatedAt: number }>>([]);
  const [claudeSessions, setClaudeSessions] = useState<Array<{ id: string; kind: 'chat' | 'cowork'; title: string; updatedAt: number; sourceSessionId: string }>>([]);
  const [localProvider, setLocalProvider] = useState<'claude' | 'claude_code'>('claude');
  const [localSessionId, setLocalSessionId] = useState('');
  const selectedClaudeId = useRef('');
  const fileReadRevision = useRef(0);
  const [importRequestId, setImportRequestId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const selectableSpaces = useMemo(
    () => spaces.filter((space) => space.reach !== 'through_channel'),
    [spaces],
  );
  const selectedClaudeSession = claudeSessions.find((session) => session.id === localSessionId);

  useEffect(() => {
    if (kind === null || kind === 'space') return;
    const nextSpaceId = selectableSpaces.some((space) => space.id === spaceId)
      ? spaceId
      : selectableSpaces[0]?.id ?? '';
    if (nextSpaceId !== spaceId) setSpaceId(nextSpaceId);
  }, [kind, selectableSpaces, spaceId]);

  useEffect(() => {
    if (kind !== 'import' || importSource !== 'claude_code' || !window.rally) return;
    let active = true;
    void desktopBridge().listLocalClaudeCodeSessions().then((sessions) => {
      if (active) setLocalSessions(sessions);
    }).catch((error: unknown) => {
      if (active) setFailure(error instanceof Error ? error.message : 'Local sessions could not be listed. Choose a JSONL file instead.');
    });
    return () => { active = false; };
  }, [kind, importSource]);

  useEffect(() => {
    if (kind !== 'import' || importSource !== 'claude_local' || !window.rally) return;
    let active = true;
    const refresh = (reloadSelected = false): void => {
      void desktopBridge().listLocalClaudeSessions().then((sessions) => {
        if (!active) return;
        setClaudeSessions(sessions);
        const id = selectedClaudeId.current;
        if (id && !sessions.some((session) => session.id === id)) {
          selectedClaudeId.current = '';
          setLocalSessionId('');
          setFileText('');
          setFailure(null);
          fileReadRevision.current += 1;
          return;
        }
        if (!reloadSelected || !id) return;
        const revision = ++fileReadRevision.current;
        setFileText('');
        setFailure(null);
        void desktopBridge().readLocalClaudeSession(id).then((result) => {
          if (!active || revision !== fileReadRevision.current || selectedClaudeId.current !== id) return;
          setFileText(result.text);
          setLocalProvider(result.provider);
          setImportRequestId(crypto.randomUUID());
        }).catch((error: unknown) => {
          if (!active || revision !== fileReadRevision.current || selectedClaudeId.current !== id) return;
          setFailure(error instanceof Error && /not saved on this Mac/.test(error.message)
            ? 'This conversation is not saved on this Mac. Open it in Claude, then try again.'
            : 'The selected Claude conversation could not be read.');
        });
      }).catch(() => {
        if (active) setFailure('Claude chats could not be listed.');
      });
    };
    refresh();
    const unsubscribe = desktopBridge().onApplicationForegroundChanged((foregrounded) => {
      if (foregrounded) refresh(true);
    });
    return () => { active = false; unsubscribe(); };
  }, [kind, importSource]);

  const open = (next: CreationKind): void => {
    setKind(next);
    setSpaceId(selectableSpaces[0]?.id ?? '');
    setName('');
    setUrl('');
    setImportSource('link');
    setFileText('');
    fileReadRevision.current += 1;
    setLocalSessions([]);
    setClaudeSessions([]);
    setLocalSessionId('');
    selectedClaudeId.current = '';
    setImportRequestId(crypto.randomUUID());
    setFailure(null);
  };
  const close = (): void => {
    if (saving) return;
    setKind(null);
    setFailure(null);
  };
  const selectedSpaceExists = selectableSpaces.some((space) => space.id === spaceId);
  const valid = Boolean(name.trim())
    && (kind === 'space' ? canCreateSpace : selectedSpaceExists)
    && (kind !== 'import' || (importSource === 'link' ? Boolean(url.trim())
      : Boolean(fileText)));
  const submit = async (): Promise<void> => {
    if (!kind || !valid || saving) return;
    setSaving(true);
    setFailure(null);
    try {
      if (kind === 'channel') await onCreateChannel({ name: name.trim(), spaceId });
      else if (kind === 'import') await onImportChannel({
        clientMessageId: importRequestId,
        name: name.trim(),
        spaceId,
        source: importSource === 'link' ? { kind: 'link', url: url.trim() }
          : { kind: 'export', provider: importSource === 'claude_local' ? localProvider : importSource, text: fileText },
      });
      else await onCreateSpace(name.trim());
      setSaving(false);
      close();
    } catch (error) {
      const fallback = kind === 'space'
        ? 'The space couldn’t be created.'
        : kind === 'import'
          ? 'The channel couldn’t be imported.'
          : 'The channel couldn’t be created.';
      setFailure(error instanceof Error && error.message.trim() ? error.message : fallback);
      setSaving(false);
    }
  };
  const title = kind === 'channel'
    ? 'Start a new channel'
    : kind === 'import'
      ? 'Import channel from Claude or ChatGPT'
      : 'Create a new space';

  return <>
    <DropdownMenu.Root>
      <Tip describesTrigger={false} label={tooltipLabel} side={tooltipSide}>
        <DropdownMenu.Trigger asChild disabled={!canCreateSpace && selectableSpaces.length === 0}>{children}</DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-content new-workstream-menu" align="start" sideOffset={6}>
          <DropdownMenu.Item className="menu-item" disabled={selectableSpaces.length === 0} onSelect={() => open('channel')}>Start New Channel…</DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" disabled={selectableSpaces.length === 0} onSelect={() => open('import')}>Import Channel from Claude or ChatGPT…</DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" disabled={!canCreateSpace} onSelect={() => open('space')}>Create New Space…</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    <Modal
      footer={<>
        <Button disabled={saving} onClick={close}>Cancel</Button>
        <Button className="button-primary" disabled={saving || !valid} form={formId} type="submit">{saving ? 'Creating…' : 'Create'}</Button>
      </>}
      onOpenChange={(next) => { if (!next) close(); }}
      open={kind !== null}
      title={title}
    >
      <form className="space-create-form" id={formId} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {kind !== 'space' && <label className="form-field">
          <span>Space</span>
          <DropdownSelect ariaLabel="Space" disabled={saving} onValueChange={(value) => {
            setSpaceId(value);
            if (kind === 'import') setImportRequestId(crypto.randomUUID());
          }} options={selectableSpaces.map((space) => ({ label: space.name, value: space.id }))} value={spaceId} />
        </label>}
        <label className="form-field">
          <span>{kind === 'space' ? 'Name of space' : 'Name of channel'}</span>
          <input autoFocus disabled={saving} maxLength={kind === 'space' ? undefined : 180} onChange={(event) => {
            setName(event.target.value);
            if (kind === 'import') setImportRequestId(crypto.randomUUID());
          }} required value={name} />
        </label>
        {kind === 'import' && <label className="form-field">
          <span>Source</span>
          <select disabled={saving} onChange={(event) => {
            setImportSource(event.target.value as ImportSource);
            setFileText('');
            fileReadRevision.current += 1;
            setLocalSessions([]);
            setClaudeSessions([]);
            setLocalSessionId('');
            selectedClaudeId.current = '';
            setImportRequestId(crypto.randomUUID());
          }} value={importSource}>
            <option value="link">Shared conversation link</option>
            <option value="claude_local">Claude chats on this Mac</option>
            <option value="claude_code">Claude Code on this Mac</option>
          </select>
        </label>}
        {kind === 'import' && (importSource === 'link' ? <label className="form-field">
          <span>URL</span>
          <input disabled={saving} onChange={(event) => {
            setUrl(event.target.value);
            setImportRequestId(crypto.randomUUID());
          }} required type="url" value={url} />
        </label> : <>
          {importSource === 'claude_local' && <>
            <label className="form-field">
              <span>Conversation</span>
              <select aria-label="Conversation" className="session-import-select" disabled={saving} title={selectedClaudeSession?.title} onChange={(event) => {
                const id = event.target.value;
                setLocalSessionId(id);
                selectedClaudeId.current = id;
                setFileText('');
                const revision = ++fileReadRevision.current;
                setImportRequestId(crypto.randomUUID());
                setFailure(null);
                if (!id) return;
                void desktopBridge().readLocalClaudeSession(id).then((result) => {
                  if (revision !== fileReadRevision.current) return;
                  setFileText(result.text);
                  setLocalProvider(result.provider);
                }).catch((error: unknown) => {
                  if (revision === fileReadRevision.current) setFailure(error instanceof Error && /not saved on this Mac/.test(error.message)
                    ? 'This conversation is not saved on this Mac. Open it in Claude, then try again.'
                    : 'The selected Claude conversation could not be read.');
                });
              }} value={localSessionId}>
                <option value="">Select a Claude conversation</option>
                {claudeSessions.map((session) => <option key={session.id} title={session.title} value={session.id}>{claudeCodeSessionOption(session, claudeSessions)}</option>)}
              </select>
            </label>
            <small>Claude saves only some chats locally. If the desired chat isn’t shown, open it in the Claude app again</small>
          </>}
          {importSource === 'claude_code' && localSessions.length > 0 && <label className="form-field">
            <span>Conversation</span>
            <select aria-label="Conversation" className="session-import-select" disabled={saving} title={localSessions.find((session) => session.id === localSessionId)?.title} onChange={(event) => {
              const id = event.target.value;
              setLocalSessionId(id);
              setFileText('');
              const revision = ++fileReadRevision.current;
              setImportRequestId(crypto.randomUUID());
              setFailure(null);
              if (!id) return;
              void desktopBridge().readLocalClaudeCodeSession(id).then((text) => {
                if (revision === fileReadRevision.current) setFileText(text);
              }).catch((error: unknown) => {
                if (revision === fileReadRevision.current) setFailure(error instanceof Error ? error.message : 'The session could not be read.');
              });
            }} value={localSessionId}>
              <option value="">Select a local conversation</option>
              {localSessions.map((session) => <option key={session.id} title={session.title} value={session.id}>{claudeCodeSessionOption(session, localSessions)}</option>)}
            </select>
          </label>}
          {importSource === 'claude_code' && <label className="form-field">
            <span>Or choose a conversation file</span>
            <input accept=".jsonl,.json,application/json" disabled={saving}
              onChange={(event) => {
                const file = event.target.files?.[0];
                setFileText('');
                const revision = ++fileReadRevision.current;
                setLocalSessionId('');
                setImportRequestId(crypto.randomUUID());
                setFailure(null);
                if (!file) return;
                void file.text().then((text) => {
                  if (revision !== fileReadRevision.current) return;
                  setFileText(text);
                }).catch((error: unknown) => {
                  if (revision === fileReadRevision.current) setFailure(error instanceof Error ? error.message : 'The file could not be read.');
                });
              }} type="file" />
          </label>}
          {importSource === 'claude_code' && <small>If a conversation is missing, choose its local file. Cloud conversations may not be saved on this Mac.</small>}
        </>)}
        {failure && <InlineError>{failure}</InlineError>}
      </form>
    </Modal>
  </>;
}
