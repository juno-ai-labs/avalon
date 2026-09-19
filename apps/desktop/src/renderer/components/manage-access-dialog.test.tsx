import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpaceSummarySchema, type ChannelAccess, type SpaceSummary } from '@rally/contracts';

import { ApiError } from '../lib/api';
import { ManageAccessDialog } from './manage-access-dialog';

const api = vi.hoisted(() => ({ channelAccess: vi.fn() }));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api }) }));

const workstreamId = '00000000-0000-7000-8000-000000000011';
const person = '00000000-0000-7000-8000-0000000000a1';
const other = '00000000-0000-7000-8000-0000000000a2';

function space(id: string, name: string, scope: 'personal' | 'workspace'): SpaceSummary {
  return SpaceSummarySchema.parse({
    id,
    name,
    iconKey: 'briefcase',
    colorKey: 'blue',
    scope,
    status: 'active',
    systemRole: null,
    revision: 1,
    participants: [{ userId: person }],
    channelCount: 1,
    defaultResourceIds: [],
    defaultSidekickIds: [],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  });
}

const general = space('00000000-0000-7000-8000-0000000000f0', 'General', 'workspace');
const hiring = space('00000000-0000-7000-8000-0000000000f2', 'Hiring', 'personal');

function renderDialog(
  access: unknown,
  props: Partial<React.ComponentProps<typeof ManageAccessDialog>> = {},
) {
  if (access instanceof Error) api.channelAccess.mockRejectedValue(access);
  else api.channelAccess.mockResolvedValue(access as ChannelAccess);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ManageAccessDialog
        onChangeScope={async () => undefined}
        onOpenChange={() => undefined}
        onRemoveFromSpace={async () => undefined}
        open
        spaces={[general, hiring]}
        workstreamId={workstreamId}
        workstreamTitle="Quarterly planning"
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('Manage access', () => {
  beforeEach(() => api.channelAccess.mockReset());

  // Both at once is what it used to draw: the message over a spinner that
  // never stopped, because nothing was left in flight to end it.
  it('given the access read failed, then it says so once, with a retry and no spinner', async () => {
    renderDialog(new Error('The access read did not answer'));

    expect(await screen.findByText('Who can see this channel couldn\u2019t be loaded.')).toBeVisible();
    expect(screen.queryByText('Loading access\u2026')).not.toBeInTheDocument();

    api.channelAccess.mockResolvedValue({
      direct: { scope: 'personal', participantUserIds: [person] },
      spaces: [],
      spaceIds: [],
    } as unknown as ChannelAccess);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Only the 1 person in the channel.')).toBeVisible();
    expect(screen.queryByText('Who can see this channel couldn\u2019t be loaded.')).not.toBeInTheDocument();
  });

  it('lists the channel\'s own source and one entry per space that reaches it', async () => {
    renderDialog({
      direct: { scope: 'personal', participantUserIds: [person, other] },
      spaces: [{ spaceId: hiring.id, scope: 'personal', participantUserIds: [person] }],
      spaceIds: [hiring.id],
    });

    expect(await screen.findByText('Only the 2 people in the channel.')).toBeVisible();
    expect(screen.getByText('Hiring')).toBeVisible();
    expect(screen.getByText('The 1 person in this space.')).toBeVisible();
  });

  // The rule this screen exists for: a Channel whose own scope is personal is
  // not private while an active Organization-wide Space still grants access.
  it('never calls a channel private while an organization-wide space grants access', async () => {
    renderDialog({
      direct: { scope: 'personal', participantUserIds: [person] },
      spaces: [{ spaceId: general.id, scope: 'workspace', participantUserIds: [] }],
      spaceIds: [general.id],
    });

    expect(await screen.findByText(/public through General/u)).toBeVisible();
    expect(screen.getByText('Everyone in the organization, through this space.')).toBeVisible();
  });

  // The directory is the Spaces this viewer can see, and a source may come from
  // one they cannot. Dropping the unnameable one would leave the sentence
  // saying only the people in the channel can read it.
  it('still says a channel is public when the space that makes it public is not in the directory', async () => {
    renderDialog({
      direct: { scope: 'personal', participantUserIds: [person] },
      spaces: [{ spaceId: '00000000-0000-7000-8000-0000000000f9', scope: 'workspace', participantUserIds: [] }],
      spaceIds: ['00000000-0000-7000-8000-0000000000f9'],
    });

    expect(await screen.findByText(/public through a space/u)).toBeVisible();
  });

  it('given a membership in a space the viewer cannot see, then it is named but not removable', async () => {
    const unseen = '00000000-0000-7000-8000-0000000000f9';
    renderDialog({
      direct: { scope: 'personal', participantUserIds: [person] },
      spaces: [{ spaceId: unseen, scope: 'personal', participantUserIds: [other] }],
      spaceIds: [unseen],
    });

    expect(await screen.findByText('A space you can\u2019t see')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove from space' })).not.toBeInTheDocument();
  });

  it('offers the public scope change on a channel whose own source is personal', async () => {
    const onChangeScope = vi.fn(async () => undefined);
    renderDialog({
      direct: { scope: 'personal', participantUserIds: [person] },
      spaces: [],
      spaceIds: [],
    }, { onChangeScope });

    fireEvent.click(await screen.findByRole('button', { name: 'Make public to organization' }));

    await waitFor(() => expect(onChangeScope).toHaveBeenCalledWith('workspace'));
  });

  // The server refuses `channel_scope_locked_by_space` exactly while an
  // Organization-wide Space holds the Channel, and those sources are on this
  // screen — so the control is not drawn rather than drawn to fail.
  it('given an organization-wide space holds the channel, then narrowing it is not offered', async () => {
    renderDialog({
      direct: { scope: 'workspace', participantUserIds: [] },
      spaces: [{ spaceId: general.id, scope: 'workspace', participantUserIds: [] }],
      spaceIds: [general.id],
    });

    expect(await screen.findByText(/public through General/u)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Make private' })).not.toBeInTheDocument();
  });

  it('given only a personal space holds the channel, then narrowing it is offered and applied', async () => {
    const onChangeScope = vi.fn(async () => undefined);
    renderDialog({
      direct: { scope: 'workspace', participantUserIds: [] },
      spaces: [{ spaceId: hiring.id, scope: 'personal', participantUserIds: [person] }],
      spaceIds: [hiring.id],
    }, { onChangeScope });

    fireEvent.click(await screen.findByRole('button', { name: 'Make private' }));

    await waitFor(() => expect(onChangeScope).toHaveBeenCalledWith('personal'));
  });

  // The sources on screen are the ones the read answered with; a Space widened
  // since is the race the refusal exists for, and its copy is what says so.
  it('turns a scope locked by a space into copy naming what must change first', async () => {
    renderDialog({
      direct: { scope: 'workspace', participantUserIds: [] },
      spaces: [{ spaceId: hiring.id, scope: 'personal', participantUserIds: [person] }],
      spaceIds: [hiring.id],
    }, {
      onChangeScope: async () => {
        throw new ApiError('A Channel in “General” is public through an Organization-wide Space', 409, 'channel_scope_locked_by_space');
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Make private' }));

    expect(await screen.findByText('An organization-wide space still makes this channel public. Remove it from that space first.'))
      .toBeVisible();
    // The server's own sentence is a diagnostic, not product copy.
    expect(screen.queryByText(/is public through an Organization-wide Space/u)).not.toBeInTheDocument();
  });

  it('turns a final-membership refusal into copy naming what must change first', async () => {
    renderDialog({
      direct: { scope: 'personal', participantUserIds: [person] },
      spaces: [{ spaceId: hiring.id, scope: 'personal', participantUserIds: [person] }],
      spaceIds: [hiring.id],
    }, {
      onRemoveFromSpace: async () => {
        throw new ApiError('A Channel in “Hiring” belongs to no other Space', 409, 'space_membership_final');
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Remove from space' }));

    expect(await screen.findByText('This is the channel’s only space, and every channel needs one. Add it to another space first.'))
      .toBeVisible();
  });

  it('turns an audience-incompatible refusal into copy naming what must change first', async () => {
    renderDialog({
      direct: { scope: 'personal', participantUserIds: [person] },
      spaces: [
        { spaceId: hiring.id, scope: 'personal', participantUserIds: [person] },
        { spaceId: general.id, scope: 'workspace', participantUserIds: [] },
      ],
      spaceIds: [hiring.id, general.id],
    }, {
      onRemoveFromSpace: async () => {
        throw new ApiError('Leaving “Hiring” would leave 2 of its readers unable to find the Channel', 409, 'space_audience_incompatible');
      },
    });

    fireEvent.click((await screen.findAllByRole('button', { name: 'Remove from space' }))[0]!);

    expect(await screen.findByText('Some people who can read this channel would be left with no space to find it in. Add it to a space they can see first.'))
      .toBeVisible();
  });

  // The two lists agree in the steady state and disagree exactly while an
  // operation is in flight or has been interrupted. Averaging them away is
  // what this screen must not do.
  it('shows a membership the organization has but the channel has not recorded yet', async () => {
    renderDialog({
      direct: { scope: 'personal', participantUserIds: [person] },
      spaces: [],
      spaceIds: [hiring.id],
    });

    expect(await screen.findByText('Access from this space is still being applied.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove from space' })).toBeVisible();
  });

  it('shows a source the channel still records after the organization dropped the membership', async () => {
    renderDialog({
      direct: { scope: 'personal', participantUserIds: [person] },
      spaces: [{ spaceId: hiring.id, scope: 'personal', participantUserIds: [person] }],
      spaceIds: [],
    });

    expect(await screen.findByText('This channel has left this space; its access is still being withdrawn.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove from space' })).not.toBeInTheDocument();
  });
});
