import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Plus } from 'lucide-react';
import type { SidekickRecommendationOptions } from '@rally/contracts';
import { Button, InlineError, Modal, Tip } from './primitives';
export function SidekickPicker({ options, loading, saving, error, open, setOpen, onMenuOpen, onAttach, onCreate }: {
  options?: SidekickRecommendationOptions; loading: boolean; saving: boolean; error?: string;
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
        <button className="workstream-context-row workstream-add-sidekick" type="button" aria-label="Add Sidekick">
          <span className="workstream-context-mark" aria-hidden="true"><Plus size={18} /></span>
          <span className="workstream-context-copy"><span>Add Sidekick</span></span>
        </button>
      </DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-content" align="start" sideOffset={4}>
          {loading && <DropdownMenu.Label className="menu-label">Loading Sidekicks…</DropdownMenu.Label>}
          {error && <InlineError>{error}</InlineError>}
          {!loading && options && !options.canManage && <DropdownMenu.Label className="menu-label">Sidekick management is unavailable here.</DropdownMenu.Label>}
          <DropdownMenu.Item className="menu-item" disabled={!options?.canManage} onSelect={() => setOpen(true)}>Attach existing Sidekick</DropdownMenu.Item>
          {onCreate && <DropdownMenu.Item className="menu-item" disabled={!options?.canManage} onSelect={() => void onCreate()}>Create new Sidekick</DropdownMenu.Item>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    <Modal open={open} onOpenChange={setOpen} title="Attach existing Sidekick">
      <input className="sidekick-picker-search" aria-label="Search workspace Sidekicks" placeholder="Search workspace Sidekicks" value={search} onChange={(event) => setSearch(event.target.value)} />
      {loading && <p>Loading Sidekicks…</p>}
      {error && <InlineError>{error}</InlineError>}
      {items?.length === 0 && <p>No workspace Sidekicks found.</p>}
      <ul className="sidekick-picker-list">{items?.map((item) => <li key={item.id}>
        <Button aria-label={item.name} aria-description={item.description} disabled={saving} onClick={() => onAttach(item.id)}><strong>{item.name}</strong><span>{item.description}</span></Button>
      </li>)}</ul>
    </Modal>
  </>;
}
