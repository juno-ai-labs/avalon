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

function space(
  id: string,
  name: string,
  scope: 'personal' | 'workspace',
  reach: SpaceSummary['reach'] = 'participant',
): SpaceSummary {
  return SpaceSummarySchema.parse({
    id,
    name,
    iconKey: 'briefcase',
    colorKey: 'blue',
    scope,
    status: 'active',
    systemRole: null,
    revision: 1,
    reach,
    participants: reach === 'through_channel' ? [] : [{ userId: person }],
    channelCount: 1,
    defaultResourceIds: [],
    defaultSidekickIds: [],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  });
}

const general = space('00000000-0000-7000-8000-0000000000f0', 'General', 'workspace');
const hiring = space('00000000-0000-7000-8000-0000000000f2', 'Hiring', 'workspace');

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

    expect(await screen.findByText('Who can see this channel couldn’t be loaded.')).toBeVisible();
    expect(screen.queryByText('Loading access\u2026')).not.toBeInTheDocument();

    api.channelAccess.mockResolvedValue({
      direct: { scope: 'personal', participantUserIds: [person] },
      spaces: [],
      spaceIds: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Only the 1 person in the channel.')).toBeVisible();
    expect(screen.queryByText('Who can see this channel couldn’t be loaded.')).not.toBeInTheDocument();
  });

  it('says who reads the channel from the channel alone, and lists each space it is placed in', async () => {
    renderDialog({
      direct: { scope: 'personal', participantUserIds: [person, other] },
      spaces: [],
      spaceIds: [hiring.id, general.id],
    });

    expect(await screen.findByText('Only the 2 people in the channel.')).toBeVisible();
    expect(screen.getByText('Hiring')).toBeVisible();
    expect(screen.getByText('General')).toBeVisible();
    // An Organization-wide Space beside it does not make it public.
    expect(screen.getAllByText('The channel is placed here. A space doesn’t change who can read it.')).toHaveLength(2);
    expect(screen.queryByText(/Everyone in the organization/u)).not.toBeInTheDocument();
  });

  it('given a membership in a space the viewer cannot see, then it is named but not removable', async () => {
    const unseen = '00000000-0000-7000-8000-0000000000f9';
    renderDialog({
      direct: { scope: 'personal', participantUserIds: [person] },
      spaces: [],
      spaceIds: [unseen],
    });

    expect(await screen.findByText('A space you can’t see')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove from space' })).not.toBeInTheDocument();
  });

  // A reader who can open this Channel is told the mark and name of every
  // Space holding it; leaving one is still not theirs to do.
  it('given a space reached through this channel, then it is named but not removable', async () => {
    const reached = space('00000000-0000-7000-8000-0000000000f5', 'Side work', 'workspace', 'through_channel');
    renderDialog({
      direct: { scope: 'workspace', participantUserIds: [person] },
      spaces: [],
      spaceIds: [reached.id],
    }, { spaces: [general, hiring, reached] });

    expect(await screen.findByText('Side work')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove from space' })).not.toBeInTheDocument();
  });

  it('offers the public scope change on a private channel', async () => {
    const onChangeScope = vi.fn(async () => undefined);
    renderDialog({
      direct: { scope: 'personal', participantUserIds: [person] },
      spaces: [],
      spaceIds: [general.id],
    }, { onChangeScope });

    fireEvent.click(await screen.findByRole('button', { name: 'Make public to organization' }));

    await waitFor(() => expect(onChangeScope).toHaveBeenCalledWith('workspace'));
  });

  // No Space holds a Channel open any more, so a public Channel in General can
  // always be made private from here.
  it('given a public channel in an organization-wide space, then making it private is offered and applied', async () => {
    const onChangeScope = vi.fn(async () => undefined);
    renderDialog({
      direct: { scope: 'workspace', participantUserIds: [] },
      spaces: [],
      spaceIds: [general.id],
    }, { onChangeScope });

    expect(await screen.findByText('Everyone in the organization.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Make private' }));

    await waitFor(() => expect(onChangeScope).toHaveBeenCalledWith('personal'));
  });

  it('turns a final-membership refusal into copy naming what must change first', async () => {
    renderDialog({
      direct: { scope: 'personal', participantUserIds: [person] },
      spaces: [],
      spaceIds: [hiring.id],
    }, {
      onRemoveFromSpace: async () => {
        throw new ApiError('A Channel in “Hiring” belongs to no other Space', 409, 'space_membership_final');
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Remove from space' }));

    expect(await screen.findByText('Every channel needs a space, and this would leave one with none. Add it to another space first.'))
      .toBeVisible();
  });
});
