import { useState } from 'react';
import { SidekickPicker as SharedSidekickPicker } from '@rally/ui/components/sidekick-picker';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCollaborationSession } from '../lib/collaboration-session';

/** Recommends workspace knowledge to every conversation in this workstream. */
export function SidekickPicker(props: { workstreamId: string; substreamId?: string }): React.JSX.Element {
  return <WorkstreamSidekickPicker key={`${props.workstreamId}:${props.substreamId ?? '0'}`} {...props} />;
}

function WorkstreamSidekickPicker({ workstreamId, substreamId = '0' }: { workstreamId: string; substreamId?: string }): React.JSX.Element | null {
  const { api, session, createSidekick } = useCollaborationSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const directory = useQuery({ queryKey: ['sidekick-recommendation-options', workstreamId, substreamId],
    queryFn: ({ signal }) => api!.getSidekickRecommendationOptions(workstreamId, substreamId, signal),
    enabled: false });
  const attach = useMutation({
    mutationFn: (sidekickId: string) => api!.setRecommendedSidekick(workstreamId, sidekickId, true, substreamId),
    onSuccess: async (items) => {
      // Recommendation ownership is shared, but source eligibility is checked
      // for each conversation. Do not seed a child's cache with Main's answer.
      await queryClient.cancelQueries({ queryKey: ['recommended-sidekicks', workstreamId, substreamId], exact: true });
      queryClient.setQueryData(['recommended-sidekicks', workstreamId, substreamId], items);
      await queryClient.invalidateQueries({ queryKey: ['recommended-sidekicks', workstreamId],
        predicate: (query) => query.queryKey[2] !== substreamId });
      await queryClient.invalidateQueries({ queryKey: ['sidekick-recommendation-options', workstreamId] });
      setOpen(false);
    },
    onError: () => { void queryClient.invalidateQueries({ queryKey: ['sidekick-recommendation-options', workstreamId] }); },
  });
  if (!session) return null;
  return <SharedSidekickPicker options={directory.data} loading={directory.isPending} saving={attach.isPending}
    failure={directory.error ? 'load' : attach.error ? 'attach' : undefined} open={open} setOpen={setOpen}
    onMenuOpen={(opened) => {
      if (!opened) return;
      attach.reset();
      void directory.refetch();
    }}
    onAttach={(id) => attach.mutate(id)} onCreate={createSidekick ?? undefined} />;
}
