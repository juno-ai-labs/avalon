import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Plus } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCollaborationSession } from '../lib/collaboration-session';
import { Button, InlineError, Modal, Tip } from './primitives';

/** Recommends workspace knowledge to every conversation in this workstream. */
export function SidekickPicker(props: { workstreamId: string; substreamId?: string }): React.JSX.Element {
  return <WorkstreamSidekickPicker key={`${props.workstreamId}:${props.substreamId ?? '0'}`} {...props} />;
}

function WorkstreamSidekickPicker({ workstreamId, substreamId = '0' }: { workstreamId: string; substreamId?: string }): React.JSX.Element | null {
  const { api, session, createSidekick } = useCollaborationSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const directory = useQuery({ queryKey: ['sidekick-recommendation-options', workstreamId, substreamId],
    queryFn: ({ signal }) => api!.getSidekickRecommendationOptions(workstreamId, substreamId, signal),
    enabled: Boolean(api && session), refetchOnWindowFocus: 'always' });
  const attach = useMutation({
    mutationFn: (sidekickId: string) => api!.setRecommendedSidekick(workstreamId, sidekickId, true, substreamId),
    onSuccess: async (items) => {
      // Recommendation ownership is shared, but source eligibility is checked
      // for each conversation. Do not seed a child's cache with Main's answer.
      await queryClient.cancelQueries({ queryKey: ['recommended-sidekicks', workstreamId] });
      queryClient.setQueryData(['recommended-sidekicks', workstreamId, substreamId], items);
      await queryClient.invalidateQueries({ queryKey: ['recommended-sidekicks', workstreamId] });
      await queryClient.invalidateQueries({ queryKey: ['sidekick-recommendation-options', workstreamId] });
      setOpen(false);
    },
    onError: () => { void queryClient.invalidateQueries({ queryKey: ['sidekick-recommendation-options', workstreamId] }); },
  });
  const items = directory.data?.items.filter((item) => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  if (!session || !directory.data?.canManage) return null;
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
          {createSidekick && <DropdownMenu.Item className="menu-item" onSelect={() => void createSidekick()}>Create new Sidekick</DropdownMenu.Item>}
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
