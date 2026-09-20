import { useQuery } from '@tanstack/react-query';
import { Globe2, Lock } from 'lucide-react';
import { useState } from 'react';
import type { ChannelAccess, SpaceSummary } from '@rally/contracts';
import { SpaceIcon } from '@rally/ui/components/space-appearance-picker';

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
 * Where a Channel's readers come from, and the two changes a person can make
 * to that from here.
 *
 * Replaces **Make private**, which could only ever describe the Channel's own
 * scope. A Channel's audience is now the union of its direct source and every
 * active Space that holds it, so a control that narrowed the direct source
 * alone would claim a privacy the Space beside it was still contradicting. The
 * rule this screen is built to keep is in the PRD: Rally never says a Channel
 * is private while an active Organization-wide Space still grants access to it.
 *
 * The two lists the server answers with are rendered as one union on purpose.
 * The Channel's own provenance and the Organization's memberships agree in the
 * steady state and disagree exactly while an operation is in flight or has been
 * interrupted — which is the thing this screen has to be able to show.
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
  const bySpace = new Map((sources?.spaces ?? []).map((source) => [source.spaceId as string, source]));
  const spaceIds = [...new Set([
    ...(sources?.spaceIds ?? []).map((id) => id as string),
    ...bySpace.keys(),
  ])];
  // Every Organization-wide Space *source*: the Channel's own provenance rather
  // than the Organization's membership list, because a source is what grants
  // access now and a membership still being applied grants nothing yet. A Space
  // this viewer's directory does not hold is named "a space" rather than
  // dropped — losing it would leave the sentence below saying only the people
  // in the Channel can read it, which is the one thing this screen may not say.
  const publicThrough = (sources?.spaces ?? [])
    .filter((source) => source.scope === 'workspace')
    .map((source) => spaces.find((space) => space.id === source.spaceId)?.name ?? 'a space');
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
              // Narrowing the direct source is refused with
              // `channel_scope_locked_by_space` exactly while an Organization-wide
              // Space holds this Channel, and those sources are on this screen: a
              // control that can only fail is worse than one that is not there,
              // and the sentence beside it names the Space to change first.
              action={directIsPublic
                ? publicThrough.length > 0
                  ? undefined
                  : <Button disabled={saving !== null} onClick={() => void run('direct', () => onChangeScope('personal'))}>Make private</Button>
                : <Button disabled={saving !== null} onClick={() => void run('direct', () => onChangeScope('workspace'))}>Make public to organization</Button>}
              failure={failures['direct']}
              icon={directIsPublic
                ? <Globe2 aria-hidden="true" size={15} />
                : <Lock aria-hidden="true" size={15} />}
              key="direct"
              name="This channel"
              // Never "private": an Organization-wide Space below may still be
              // granting access, and saying private here would be false.
              sentence={directIsPublic
                ? publicThrough.length > 0
                  ? `Everyone in the organization, from the channel itself — and public through ${publicThrough.join(', ')}.`
                  : 'Everyone in the organization, from the channel itself.'
                : publicThrough.length > 0
                  ? `The ${people(sources.direct.participantUserIds.length)} in the channel — and public through ${publicThrough.join(', ')}.`
                  : `Only the ${people(sources.direct.participantUserIds.length)} in the channel.`}
            />
            {spaceIds.map((spaceId) => {
              const source = bySpace.get(spaceId);
              const space = spaces.find((candidate) => candidate.id === spaceId);
              const member = (sources.spaceIds as string[]).includes(spaceId);
              return (
                <AccessSource
                  // A membership in a Space this viewer's directory does not
                  // hold is still listed — it is one of the sources granting
                  // access — but carries no control: the row cannot name what
                  // leaving it would change, and the server refuses an edit to
                  // a Space the caller may not read anyway.
                  action={member && space !== undefined
                    ? <Button disabled={saving !== null} onClick={() => void run(spaceId, () => onRemoveFromSpace(spaceId))}>Remove from space</Button>
                    : undefined}
                  failure={failures[spaceId]}
                  icon={space ? <SpaceIcon space={space} /> : <Globe2 aria-hidden="true" size={15} />}
                  key={spaceId}
                  name={space?.name ?? 'A space you can’t see'}
                  sentence={!member
                    // The Organization no longer holds this membership while the
                    // Channel still records its source: a retraction in flight.
                    ? 'This channel has left this space; its access is still being withdrawn.'
                    : source === undefined
                      ? 'Access from this space is still being applied.'
                      : source.scope === 'workspace'
                        ? 'Everyone in the organization, through this space.'
                        : `The ${people(source.participantUserIds.length)} in this space.`}
                />
              );
            })}
          </ul>}
    </Modal>
  );
}
