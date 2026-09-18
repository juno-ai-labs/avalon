import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Plus } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NEW_SIDEKICK_TARGET } from '../../common/sidekicks';
import { useAppSession } from '../lib/app-session';
import { desktopBridge } from '../lib/platform';
import { Button, InlineError, Modal, Tip } from './primitives';

/** Recommends workspace knowledge to every conversation in this workstream. */
export function SidekickPicker(props: { workstreamId: string; participantIds: string[] }): React.JSX.Element {
  return <WorkstreamSidekickPicker key={props.workstreamId} {...props} />;
}

function WorkstreamSidekickPicker({ workstreamId, participantIds }: { workstreamId: string; participantIds: string[] }): React.JSX.Element | null {
  const { api, session } = useAppSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const directory = useQuery({ queryKey: ['sidekicks-library'], queryFn: ({ signal }) => api!.getSidekicks(signal), enabled: Boolean(api && open) });
  const attach = useMutation({
    mutationFn: (sidekickId: string) => api!.setRecommendedSidekick(workstreamId, sidekickId, true),
    onSuccess: async (items) => {
      await queryClient.cancelQueries({ queryKey: ['recommended-sidekicks', workstreamId], exact: true });
      queryClient.setQueryData(['recommended-sidekicks', workstreamId], items);
      setOpen(false);
    },
  });
  const items = directory.data?.filter((item) => item.scope === 'workspace' && item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  if (!session || !participantIds.includes(session.user.id)) return null;
  return <>
    <DropdownMenu.Root>
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
          <DropdownMenu.Item className="menu-item" onSelect={() => setOpen(true)}>Attach existing Sidekick</DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={() => void desktopBridge().openSidekicks(NEW_SIDEKICK_TARGET)}>Create new Sidekick</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    <Modal open={open} onOpenChange={setOpen} title="Attach existing Sidekick">
      <input className="sidekick-picker-search" aria-label="Search workspace Sidekicks" placeholder="Search workspace Sidekicks" value={search} onChange={(event) => setSearch(event.target.value)} />
      {directory.isPending && <p>Loading Sidekicks…</p>}
      {(directory.error || attach.error) && <InlineError>{(directory.error ?? attach.error)?.message}</InlineError>}
      {items?.length === 0 && <p>No workspace Sidekicks found.</p>}
      <ul className="sidekick-picker-list">{items?.map((item) => <li key={item.id}>
        <Button aria-label={item.name} aria-description={item.description} disabled={attach.isPending} onClick={() => attach.mutate(item.id)}><strong>{item.name}</strong><span>{item.description}</span></Button>
      </li>)}</ul>
    </Modal>
  </>;
}
