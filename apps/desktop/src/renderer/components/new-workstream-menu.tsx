import type { SpaceSummary } from '@rally/contracts';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { cloneElement, useId, useMemo, useState, type MouseEvent, type ReactElement, type SyntheticEvent } from 'react';

import { useSpaceChoices } from '../lib/space-choices';
import { Button, InlineError, Modal, Tip } from './primitives';

/**
 * A press on the list itself rather than on something in it: a link, a button,
 * a field, or anything portalled out of the list's DOM is not empty space.
 */
function isEmptySpace(event: SyntheticEvent<Element>): boolean {
  const target = event.target as Element;
  return event.currentTarget.contains(target)
    && !target.closest('a, button, input, textarea, [contenteditable="true"]');
}

/**
 * The one creation launcher shared by the expanded sidebar, the compact rail
 * and a right-click on the channel list. `trigger="context"` opens the same
 * items at the pointer instead of below a button, for a right-click on a
 * list's empty space: a click on a link or button, or on a row with its own
 * menu, is not empty space. `offer` narrows the items to the channel ones or
 * the Space one. `lockedSpaceId` is the
 * Space the reader is looking at: a new Channel starts in it, and the import
 * window starts on it and offers no other. Under **All** a new Channel starts
 * in General, which every picker lists first. Starting a Channel opens the
 * new-Channel screen straight away, which names and places it beside its
 * composer; only a Space is created through a dialog. `trigger="direct"` skips
 * the menu: the child does the one thing `offer` names, for a button that only
 * ever does that.
 */
export function NewWorkstreamMenu({
  children,
  canCreateSpace = true,
  lockedSpaceId,
  offer = 'all',
  spaces = [],
  onCreateChannel,
  onCreateSpace,
  tooltipLabel = 'New channel',
  tooltipSide = 'bottom',
  trigger = 'dropdown',
  disabled = false,
}: {
  children: ReactElement;
  /** Context trigger only: leaves the list mounted while no menu opens. */
  disabled?: boolean;
  canCreateSpace?: boolean;
  lockedSpaceId?: string | null;
  offer?: 'all' | 'channel' | 'space';
  trigger?: 'dropdown' | 'context' | 'direct';
  tooltipSide?: 'bottom' | 'right';
  spaces?: SpaceSummary[];
  onCreateChannel: (input: { spaceId: string }) => void;
  onCreateSpace: (name: string) => Promise<void>;
  tooltipLabel?: string;
}): React.JSX.Element {
  const formId = useId();
  const [spaceDialogOpen, setSpaceDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const lock = lockedSpaceId ?? null;
  // A locked Space is the only choice; one reached only through a shared
  // Channel leaves none, which disables the items.
  const spaceLocked = lock !== null;
  const choices = useSpaceChoices(spaces);
  const selectableSpaces = useMemo(
    () => choices.filter((space) => space.reach !== 'through_channel'
      && (lock === null || space.id === lock)),
    [choices, lock],
  );

  const startChannel = (): void => {
    const spaceId = selectableSpaces[0]?.id;
    if (spaceId) onCreateChannel({ spaceId });
  };
  const openSpaceDialog = (): void => {
    setSpaceDialogOpen(true);
    setName('');
    setFailure(null);
  };
  const close = (): void => {
    if (saving) return;
    setSpaceDialogOpen(false);
    setFailure(null);
  };
  const valid = Boolean(name.trim()) && canCreateSpace;
  const submit = async (): Promise<void> => {
    if (!valid || saving) return;
    setSaving(true);
    setFailure(null);
    try {
      await onCreateSpace(name.trim());
      setSaving(false);
      close();
    } catch (error) {
      setFailure(error instanceof Error && error.message.trim() ? error.message : 'The space couldn’t be created.');
      setSaving(false);
    }
  };
  // Importing reads the conversation in Rally's own browser, which only the
  // desktop host has; the web host offers no import.
  const openBrowserImport = window.rally?.openBrowserImport;

  const Item = trigger === 'context' ? ContextMenu.Item : DropdownMenu.Item;
  const items = <>
    {offer !== 'space' && <>
      <Item className="menu-item" disabled={selectableSpaces.length === 0} onSelect={startChannel}>Start New Channel</Item>
      {openBrowserImport && <Item className="menu-item" disabled={selectableSpaces.length === 0} onSelect={() => {
        void openBrowserImport({
          spaces: selectableSpaces.map((space) => ({ id: space.id, name: space.name })),
          ...(spaceLocked ? { spaceLocked } : {}),
        });
      }}>Import Channel from Claude or ChatGPT</Item>}
    </>}
    {offer !== 'channel' && <Item className="menu-item" disabled={!canCreateSpace} onSelect={openSpaceDialog}>Create New Space</Item>}
  </>;

  const direct = trigger === 'direct' && offer !== 'all'
    ? <Tip describesTrigger={false} label={tooltipLabel} side={tooltipSide}>
      {cloneElement(children as ReactElement<{ disabled?: boolean; onClick?: (event: MouseEvent) => void }>, {
        disabled: offer === 'space' ? !canCreateSpace : selectableSpaces.length === 0,
        onClick: offer === 'space' ? openSpaceDialog : startChannel,
      })}
    </Tip>
    : null;

  return <>
    {direct ?? (trigger === 'context' ? <ContextMenu.Root>
      <ContextMenu.Trigger asChild disabled={disabled} onContextMenu={(event) => {
        // Claims the click so the menu stays shut; a row's own menu has
        // already claimed it the same way. A portalled menu or dialog opened
        // from a row still bubbles here through the React tree, so a target
        // outside the list's DOM is not its empty space either.
        if (!isEmptySpace(event)) event.preventDefault();
      }} onPointerDown={(event) => {
        // A touch opens the menu on a long press, which never passes through
        // `contextmenu`, so the guard above has to be repeated here: without
        // it a long press on a row opened this menu over the row's own.
        // Radix skips its long-press timer for a press already claimed.
        if (event.pointerType !== 'mouse' && !isEmptySpace(event)) event.preventDefault();
      }}>{children}</ContextMenu.Trigger>
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
    </DropdownMenu.Root>)}
    <Modal
      footer={<>
        <Button disabled={saving} onClick={close}>Cancel</Button>
        <Button className="button-primary" disabled={saving || !valid} form={formId} type="submit">{saving ? 'Creating…' : 'Create'}</Button>
      </>}
      onOpenChange={(next) => { if (!next) close(); }}
      open={spaceDialogOpen}
      title="Create a new space"
    >
      <form className="space-create-form" id={formId} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label className="form-field">
          <span>Name of space</span>
          <input autoFocus disabled={saving} onChange={(event) => setName(event.target.value)} required value={name} />
        </label>
        {failure && <InlineError>{failure}</InlineError>}
      </form>
    </Modal>
  </>;
}
