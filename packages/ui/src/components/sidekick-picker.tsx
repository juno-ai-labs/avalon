import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Plus } from 'lucide-react';
import type { SidekickRecommendationOptions } from '@rally/contracts';
import { Button, ErrorNotice, Modal, Tip } from './primitives';
import { SidebarRow } from './resizable-sidebar';
import { SidebarNavigationRowContent } from './navigation';
export type SidekickPickerFailure = 'load' | 'attach';

const sidekickPickerFailureCopy: Record<SidekickPickerFailure, string> = {
  load: 'Sidekick options couldn’t be loaded.',
  attach: 'That Sidekick couldn’t be added.',
};

export function SidekickPicker({ options, loading, saving, failure, open, setOpen, onMenuOpen, onAttach, onCreate }: {
  options?: SidekickRecommendationOptions; loading: boolean; saving: boolean; failure?: SidekickPickerFailure;
  open: boolean; setOpen: (open: boolean) => void; onMenuOpen: (open: boolean) => void;
  onAttach: (id: string) => void; onCreate?: () => void | Promise<void>;
}): React.JSX.Element | null {
  const [search, setSearch] = useState('');
  if (options?.canManage === false) return null;
  const items = options?.items.filter((item) => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));

  return <>
    <DropdownMenu.Root onOpenChange={onMenuOpen}>
      <Tip label="Add Sidekick" side="right" describesTrigger={false}>
      <DropdownMenu.Trigger asChild>
        <SidebarRow className="workstream-context-row workstream-add-sidekick" type="button" aria-label="Add Sidekick">
          <SidebarNavigationRowContent icon={<Plus size={18} />} title="Add Sidekick" />
        </SidebarRow>
      </DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-content" align="start" sideOffset={4}>
          {loading && <DropdownMenu.Label className="menu-label">Loading Sidekicks…</DropdownMenu.Label>}
          {failure && <ErrorNotice>{sidekickPickerFailureCopy[failure]}</ErrorNotice>}
          {!loading && options && !options.canManage && <DropdownMenu.Label className="menu-label">Sidekick management is unavailable here.</DropdownMenu.Label>}
          <DropdownMenu.Item className="menu-item" disabled={!options?.canManage} onSelect={() => setOpen(true)}>Attach existing Sidekick</DropdownMenu.Item>
          {onCreate && <DropdownMenu.Item className="menu-item" disabled={!options?.canManage} onSelect={() => void onCreate()}>Create new Sidekick</DropdownMenu.Item>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    <Modal open={open} onOpenChange={setOpen} title="Attach existing Sidekick">
      <input className="sidekick-picker-search" aria-label="Search organization Sidekicks" placeholder="Search organization Sidekicks" value={search} onChange={(event) => setSearch(event.target.value)} />
      {loading && <p>Loading Sidekicks…</p>}
      {failure && <ErrorNotice>{sidekickPickerFailureCopy[failure]}</ErrorNotice>}
      {items?.length === 0 && <p>No organization Sidekicks found.</p>}
      <ul className="sidekick-picker-list">{items?.map((item) => <li key={item.id}>
        <Button aria-label={item.name} aria-description={item.description} disabled={saving} onClick={() => onAttach(item.id)}><strong>{item.name}</strong><span>{item.description}</span></Button>
      </li>)}</ul>
    </Modal>
  </>;
}
