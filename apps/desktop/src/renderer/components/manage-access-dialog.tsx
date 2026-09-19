import { useQuery } from '@tanstack/react-query';
import { Globe2, Lock } from 'lucide-react';
import { useState } from 'react';
import type { ChannelAccess, SpaceErrorCode, SpaceSummary } from '@rally/contracts';
import { SpaceIcon } from '@rally/ui/components/space-appearance-picker';

import { ApiError } from '../lib/api';
import { useAppSession } from '../lib/app-session';
import { Button, InlineError, LoadingState, Modal } from './primitives';

/**
 * Every way a change made from this dialog is refused, and the sentence for it.
 *
 * Exhaustive over the server's closed `SpaceErrorCode` union plus the one code
 * that is not a Space refusal at all — a request that never got an answer. The
 * table is what makes a refusal actionable: each of these says what has to
 * change first, which a status code and a transport message cannot.
 *
 * Two of them are the whole reason this screen exists rather than a toggle.
 * `space_membership_final` is the invariant that every Channel has a home;
 * `space_audience_incompatible` is the weaker one, that a reader who keeps
 * access through another source still has to be able to *find* the Channel.
 */
type ManageAccessFailure = SpaceErrorCode | 'unavailable';

const manageAccessFailureCopy: Record<ManageAccessFailure, string> = {
  space_access_denied: 'You can’t change who sees this channel.',
  space_not_found: 'That space no longer exists.',
  space_protected: 'General’s audience can’t be changed.',
  space_membership_final: 'This is the channel’s only space, and every channel needs one. Add it to another space first.',
  space_audience_incompatible: 'Some people who can read this channel would be left with no space to find it in. Add it to a space they can see first.',
  channel_scope_locked_by_space: 'An organization-wide space still makes this channel public. Remove it from that space first.',
  space_membership_content_fence: 'This channel holds content the wider audience isn’t allowed to read.',
  space_default_audience_mismatch: 'Everyone who can read this channel must be able to use that resource or Sidekick.',
  space_revision_conflict: 'The space changed while this was being applied. Try again.',
  space_bootstrap_pending: 'Rally is still opening this organization. Try again in a moment.',
  unavailable: 'That change couldn’t be saved. Try again in a moment.',
};

/** "1 person", "2 people" — a count a sentence can be built around. */
function people(count: number): string {
  return count === 1 ? '1 person' : `${count} people`;
}

function failureOf(cause: unknown): ManageAccessFailure {
  const code = cause instanceof ApiError ? cause.code : undefined;
  // A code outside the closed union is a transport or session failure rather
  // than a Space refusal, and `unavailable` is the only honest thing to say
  // about it — never the server's own sentence, which is not written for a
  // person and is not stable.
  return code !== undefined && code in manageAccessFailureCopy
    ? code as ManageAccessFailure
    : 'unavailable';
}

/** One source of access, however it reaches the Channel. */
function AccessSource({ action, failure, icon, name, sentence }: {
  action?: React.ReactNode;
  failure?: ManageAccessFailure | null | undefined;
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
      {failure && <InlineError>{manageAccessFailureCopy[failure]}</InlineError>}
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
  const [failures, setFailures] = useState<Record<string, ManageAccessFailure>>({});
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
      setFailures((current) => ({ ...current, [key]: failureOf(cause) }));
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
      {access.isError && <InlineError>Who can see this channel couldn’t be loaded.</InlineError>}
      {sources === undefined
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
              ? 'Everyone in the organization, from the channel itself.'
              // Never "private": an Organization-wide Space below may still be
              // granting access, and saying private here would be false.
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
                action={member
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
