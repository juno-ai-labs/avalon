import type { SpaceSummary } from '@rally/contracts';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEffect, useId, useMemo, useState, type ReactElement } from 'react';

import { Button, DropdownSelect, InlineError, Modal, Tip } from './primitives';

type CreationKind = 'channel' | 'import' | 'space';

/** The one creation launcher shared by the expanded sidebar and compact rail. */
export function NewWorkstreamMenu({
  children,
  canCreateSpace = true,
  spaces = [],
  onCreateChannel,
  onCreateSpace,
  onImportChannel,
  onStart,
  tooltipSide = 'bottom',
}: {
  children: ReactElement;
  canCreateSpace?: boolean;
  tooltipSide?: 'bottom' | 'right';
  spaces?: SpaceSummary[];
  onCreateChannel: (input: { name: string; spaceId: string }) => Promise<void>;
  onCreateSpace: (name: string) => Promise<void>;
  onImportChannel: (input: { clientMessageId: string; name: string; spaceId: string; url: string }) => Promise<void>;
  onStart: () => void;
}): React.JSX.Element {
  const formId = useId();
  const [kind, setKind] = useState<CreationKind | null>(null);
  const [spaceId, setSpaceId] = useState('');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [importRequestId, setImportRequestId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const selectableSpaces = useMemo(
    () => spaces.filter((space) => space.reach !== 'through_channel'),
    [spaces],
  );

  useEffect(() => {
    if (kind === null || kind === 'space') return;
    const nextSpaceId = selectableSpaces.some((space) => space.id === spaceId)
      ? spaceId
      : selectableSpaces[0]?.id ?? '';
    if (nextSpaceId !== spaceId) setSpaceId(nextSpaceId);
  }, [kind, selectableSpaces, spaceId]);

  const open = (next: CreationKind): void => {
    setKind(next);
    setSpaceId(selectableSpaces[0]?.id ?? '');
    setName('');
    setUrl('');
    setImportRequestId(crypto.randomUUID());
    setFailure(null);
    if (next === 'channel') onStart();
  };
  const close = (): void => {
    if (saving) return;
    setKind(null);
    setFailure(null);
  };
  const selectedSpaceExists = selectableSpaces.some((space) => space.id === spaceId);
  const valid = Boolean(name.trim())
    && (kind === 'space' ? canCreateSpace : selectedSpaceExists)
    && (kind !== 'import' || Boolean(url.trim()));
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
        url: url.trim(),
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
      <Tip describesTrigger={false} label="New channel" side={tooltipSide}>
        <DropdownMenu.Trigger asChild disabled={!canCreateSpace && selectableSpaces.length === 0}>{children}</DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-content" align="start" sideOffset={6}>
          <DropdownMenu.Item className="menu-item" disabled={selectableSpaces.length === 0} onSelect={() => open('channel')}>Start a new channel</DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" disabled={selectableSpaces.length === 0} onSelect={() => open('import')}>Import channel from Claude or ChatGPT</DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" disabled={!canCreateSpace} onSelect={() => open('space')}>Create a new space</DropdownMenu.Item>
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
          <span>URL</span>
          <input disabled={saving} onChange={(event) => {
            setUrl(event.target.value);
            setImportRequestId(crypto.randomUUID());
          }} required type="url" value={url} />
        </label>}
        {failure && <InlineError>{failure}</InlineError>}
      </form>
    </Modal>
  </>;
}
