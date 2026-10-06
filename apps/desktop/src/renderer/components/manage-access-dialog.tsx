import { useQuery } from '@tanstack/react-query';
import { Globe2, Lock } from 'lucide-react';
import { useState } from 'react';
import type { ChannelAccess, SpaceSummary } from '@rally/contracts';
import { SpaceIcon } from '@rally/ui/components/space-icon';

import { useAppSession } from '../lib/app-session';
import { spaceFailureCopy, spaceFailureOf, type SpaceFailure } from '../lib/space-failure-copy';
import { Button, InlineError, LoadingState, Modal } from './primitives';

/** "1 person", "2 people" — a count a sentence can be built around. */
function people(count: number): string {
  return count === 1 ? '1 person' : `${count} people`;
}

/** One source of access, however it reaches the Channel. */
function AccessSource({ action, failure, icon, name, sentence }: {
  action?: React.ReactNode;
  failure?: SpaceFailure | null | undefined;
  icon: React.ReactNode;
  name: string;
  sentence: string;
}): React.JSX.Element {
  return (
    <li className="manage-access-source">
      <div>
        <strong>{icon}{name}</strong>
        <small>{sentence}</small>
      </div>
      {action}
      {failure && <InlineError>{spaceFailureCopy[failure]}</InlineError>}
    </li>
  );
}

/**
 * Who can read a Channel, the change a person can make to that, and the
 * Spaces it sits in.
 *
 * A Channel's audience is its own: every Space is Organization-wide and grants
 * no reader, so the Channel row is the whole answer to "who can read this",
 * and the Space rows say only where the Channel is placed.
 */
export function ManageAccessDialog({
  onChangeScope,
  onOpenChange,
  onRemoveFromSpace,
  open,
  spaces,
  workstreamId,
  workstreamTitle,
}: {
  onChangeScope: (scope: 'personal' | 'workspace') => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onRemoveFromSpace: (spaceId: string) => Promise<void>;
  open: boolean;
  /** The active Space directory, for naming a Space this viewer can see. */
  spaces: SpaceSummary[];
  workstreamId: string;
  workstreamTitle: string;
}): React.JSX.Element {
  const { api } = useAppSession();
  const [saving, setSaving] = useState<string | null>(null);
  const [failures, setFailures] = useState<Record<string, SpaceFailure>>({});
  const access = useQuery<ChannelAccess>({
    queryKey: ['channel-access', workstreamId],
    queryFn: ({ signal }) => api!.channelAccess(workstreamId, signal),
    enabled: open && Boolean(api),
  });
  const run = async (key: string, change: () => Promise<void>): Promise<void> => {
    setSaving(key);
    setFailures((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      await change();
      await access.refetch();
    } catch (cause) {
      setFailures((current) => ({ ...current, [key]: spaceFailureOf(cause) }));
    } finally {
      setSaving(null);
    }
  };
  const sources = access.data;
  const directIsPublic = sources?.direct.scope === 'workspace';
  return (
    <Modal
      description={`Everyone listed here can read ${workstreamTitle}.`}
      footer={<Button onClick={() => onOpenChange(false)}>Done</Button>}
      onOpenChange={onOpenChange}
      open={open}
      title="Manage access"
    >
      {/* One of the three, never two: a failed read used to leave the spinner
          up under its own error message, so the dialog said the sources were
          still loading for as long as it stayed open. */}
      {sources === undefined && access.isError
        ? <div className="manage-access-failed">
          <InlineError>Who can see this channel couldn’t be loaded.</InlineError>
          <Button disabled={access.isFetching} onClick={() => void access.refetch()}>Try again</Button>
        </div>
        : sources === undefined
          ? <LoadingState label="Loading access…" />
          : <ul className="manage-access-list">
            <AccessSource
              action={directIsPublic
                ? <Button disabled={saving !== null} onClick={() => void run('direct', () => onChangeScope('personal'))}>Make private</Button>
                : <Button disabled={saving !== null} onClick={() => void run('direct', () => onChangeScope('workspace'))}>Make public to organization</Button>}
              failure={failures['direct']}
              icon={directIsPublic
                ? <Globe2 aria-hidden="true" size={15} />
                : <Lock aria-hidden="true" size={15} />}
              key="direct"
              name="This channel"
              sentence={directIsPublic
                ? 'Everyone in the organization.'
                : `Only the ${people(sources.direct.participantUserIds.length)} in the channel.`}
            />
            {(sources.spaceIds as string[]).map((spaceId) => {
              const space = spaces.find((candidate) => candidate.id === spaceId);
              return (
                <AccessSource
                  // A Space this viewer's directory does not hold, or one they
                  // reach only through this Channel, carries no control: the
                  // server refuses taking the Channel out of it by name.
                  action={space !== undefined && space.reach !== 'through_channel'
                    ? <Button disabled={saving !== null} onClick={() => void run(spaceId, () => onRemoveFromSpace(spaceId))}>Remove from space</Button>
                    : undefined}
                  failure={failures[spaceId]}
                  icon={space ? <SpaceIcon space={space} /> : <Globe2 aria-hidden="true" size={15} />}
                  key={spaceId}
                  name={space?.name ?? 'A space you can’t see'}
                  sentence="The channel is placed here. A space doesn’t change who can read it."
                />
              );
            })}
          </ul>}
    </Modal>
  );
}
