import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { uuidToBase58 } from '@rally/contracts/uuid-base58';
import type { RallyApi } from '../../desktop/src/renderer/lib/api';
import { SharedSpaceOverview, sharedConversationShareUrl } from '../src/conversation';

const spaceId = '00000000-0000-7000-8000-0000000000a9';
const channelId = '00000000-0000-7000-8000-0000000000b1';
const directory = {
  spaces: [{ id: spaceId, name: 'Hiring', workstreamIds: [channelId] }],
  workstreams: [{ parentId: channelId, title: 'Launch plan', conversations: [{ substreamId: '0', title: 'Main', archived: false }] }],
} as Awaited<ReturnType<RallyApi['getSharedNavigationDirectory']>>;

it('renders an addressed Space and its authorized Channel destination', () => {
  const html = renderToStaticMarkup(<MemoryRouter><SharedSpaceOverview
    encodedSpaceId={uuidToBase58(spaceId)} directory={directory}
  /></MemoryRouter>);
  expect(html).toContain('<h1>Hiring</h1>');
  expect(html).toContain(`href="/s/${uuidToBase58(spaceId)}/c/${uuidToBase58(channelId)}"`);
  expect(html).toContain('Launch plan');
});

it('does not substitute a different Space when the path names an unavailable one', () => {
  const html = renderToStaticMarkup(<MemoryRouter><SharedSpaceOverview
    encodedSpaceId={uuidToBase58('00000000-0000-7000-8000-0000000000ff')} directory={directory}
  /></MemoryRouter>);
  expect(html).toContain('This Space is not available to you.');
  expect(html).not.toContain('Launch plan');
});

it('copies the canonical addressed URL from an old browser route', () => {
  const organizationId = '00000000-0000-7000-8000-0000000000a1';
  expect(sharedConversationShareUrl('global', organizationId, directory, null, channelId, '0'))
    .toBe(`https://rallywith.ai/app/global/${uuidToBase58(organizationId)}/s/${uuidToBase58(spaceId)}/c/${uuidToBase58(channelId)}`);
});
