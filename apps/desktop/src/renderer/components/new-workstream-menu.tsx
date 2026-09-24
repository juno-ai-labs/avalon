import type { SpaceSummary } from '@rally/contracts';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEffect, useId, useMemo, useState, type ReactElement } from 'react';

import { Button, DropdownSelect, InlineError, Modal, Tip } from './primitives';

type CreationKind = 'channel' | 'space';

/**
 * The one creation launcher shared by the expanded sidebar, the compact rail
 * and a right-click on the channel list. `trigger="context"` opens the same
 * items at the pointer instead of below a button; `offerSpace={false}` drops
 * "Create New Space" where only channels belong. `lockedSpaceId` is the
 * Space the reader is looking at: both the channel form and the import window
 * start on it and do not offer another.
 */
export function NewWorkstreamMenu({
  children,
  canCreateSpace = true,
  lockedSpaceId,
  offerSpace = true,
  spaces = [],
  onCreateChannel,
  onCreateSpace,
  tooltipLabel = 'New channel',
  tooltipSide = 'bottom',
  trigger = 'dropdown',
}: {
  children: ReactElement;
  canCreateSpace?: boolean;
  lockedSpaceId?: string | null;
  offerSpace?: boolean;
  trigger?: 'dropdown' | 'context';
  tooltipSide?: 'bottom' | 'right';
  spaces?: SpaceSummary[];
  onCreateChannel: (input: { name: string; spaceId: string }) => Promise<void>;
  onCreateSpace: (name: string) => Promise<void>;
  tooltipLabel?: string;
}): React.JSX.Element {
  const formId = useId();
  const [kind, setKind] = useState<CreationKind | null>(null);
  const [spaceId, setSpaceId] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A locked Space is the only choice; one reached only through a shared
  // Channel leaves none, which disables the items.
  const spaceLocked = lockedSpaceId !== undefined && lockedSpaceId !== null;
  const selectableSpaces = useMemo(
    () => spaces.filter((space) => space.reach !== 'through_channel'
      && (!spaceLocked || space.id === lockedSpaceId)),
    [lockedSpaceId, spaceLocked, spaces],
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
    setFailure(null);
  };
  const close = (): void => {
    if (saving) return;
    setKind(null);
    setFailure(null);
  };
  const selectedSpaceExists = selectableSpaces.some((space) => space.id === spaceId);
  const valid = Boolean(name.trim())
    && (kind === 'space' ? canCreateSpace : selectedSpaceExists);
  const submit = async (): Promise<void> => {
    if (!kind || !valid || saving) return;
    setSaving(true);
    setFailure(null);
    try {
      if (kind === 'channel') await onCreateChannel({ name: name.trim(), spaceId });
      else await onCreateSpace(name.trim());
      setSaving(false);
      close();
    } catch (error) {
      const fallback = kind === 'space' ? 'The space couldn’t be created.' : 'The channel couldn’t be created.';
      setFailure(error instanceof Error && error.message.trim() ? error.message : fallback);
      setSaving(false);
    }
  };
  const title = kind === 'channel' ? 'Start a new channel' : 'Create a new space';
  // Importing reads the conversation in Rally's own browser, which only the
  // desktop host has; the web host offers no import.
  const openBrowserImport = window.rally?.openBrowserImport;

  const Item = trigger === 'context' ? ContextMenu.Item : DropdownMenu.Item;
  const items = <>
    <Item className="menu-item" disabled={selectableSpaces.length === 0} onSelect={() => open('channel')}>Start New Channel</Item>
    {openBrowserImport && <Item className="menu-item" disabled={selectableSpaces.length === 0} onSelect={() => {
      void openBrowserImport({
        spaces: selectableSpaces.map((space) => ({ id: space.id, name: space.name })),
        ...(spaceLocked ? { spaceLocked } : {}),
      });
    }}>Import Channel from Claude or ChatGPT</Item>}
    {offerSpace && <Item className="menu-item" disabled={!canCreateSpace} onSelect={() => open('space')}>Create New Space</Item>}
  </>;

  return <>
    {trigger === 'context' ? <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content new-workstream-menu" collisionPadding={8}>{items}</ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root> : <DropdownMenu.Root>
      <Tip describesTrigger={false} label={tooltipLabel} side={tooltipSide}>
        <DropdownMenu.Trigger asChild disabled={!canCreateSpace && selectableSpaces.length === 0}>{children}</DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-content new-workstream-menu" align="start" sideOffset={6}>{items}</DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>}
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
          <DropdownSelect ariaLabel="Space" disabled={saving || spaceLocked} onValueChange={setSpaceId} options={selectableSpaces.map((space) => ({ label: space.name, value: space.id }))} value={spaceId} />
        </label>}
        <label className="form-field">
          <span>{kind === 'space' ? 'Name of space' : 'Name of channel'}</span>
          <input autoFocus disabled={saving} maxLength={kind === 'space' ? undefined : 180} onChange={(event) => setName(event.target.value)} required value={name} />
        </label>
        {failure && <InlineError>{failure}</InlineError>}
      </form>
    </Modal>
  </>;
}
