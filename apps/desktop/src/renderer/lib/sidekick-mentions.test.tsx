import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SIDEBAR_LIST_QUERY_KEYS } from './sidebar-list-store';
import { conversationSidekickMentions, SidekickMentionProvider, SidekickMentionScope, useSidekickMentions } from './sidekick-mentions';
import type { AutomationSummary } from './types';

const DIGEST = '0b8c3a52-5f0e-4d6a-9a1c-1d2e3f405162';
const MINE = '7f1e2d3c-4b5a-4968-8776-655443322110';
const TRIAGE = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

function summary(id: string, name: string, scope: AutomationSummary['scope']): AutomationSummary {
  return {
    id, name, scope, description: '', status: 'active', updatedAt: '2026-11-01T00:00:00.000Z',
    appearance: { icon: 'sparkles', color: 'green' } as AutomationSummary['appearance'],
  };
}

function Names(): React.JSX.Element {
  const { list, byId } = useSidekickMentions();
  return <output>{list.map((sidekick) => `${sidekick.name}${sidekick.appearance ? '*' : ''}`).join(', ')} | {byId.has(MINE) ? 'mine' : 'no mine'}</output>;
}

describe('Sidekick mention directory', () => {
  it("offers the Organization's Sidekicks, then a conversation's own ahead of them, and no one's personal one", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(SIDEBAR_LIST_QUERY_KEYS.automations, [
      summary(DIGEST, 'Daily digest', 'workspace'),
      summary(MINE, 'My notes', 'you'),
    ]);
    const { rerender } = render(
      <QueryClientProvider client={queryClient}><SidekickMentionProvider><Names /></SidekickMentionProvider></QueryClientProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Daily digest* | no mine');

    rerender(
      <QueryClientProvider client={queryClient}><SidekickMentionProvider>
        <SidekickMentionScope sidekicks={[
          { id: TRIAGE, name: 'Triage', description: '' },
          // An attachment of an Organization Sidekick: no glyph of its own.
          { id: DIGEST, name: 'Daily digest', description: '' },
        ]}><Names /></SidekickMentionScope>
      </SidekickMentionProvider></QueryClientProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Triage, Daily digest* | no mine');
  });

  it("leaves out a recommendation or attachment nobody can vouch for as published", () => {
    const draft = { id: MINE, name: 'Half-built', description: '', available: false };
    const published = { id: TRIAGE, name: 'Triage', description: '', available: true };
    // A reader who cannot list the thread's own Sidekicks sees only these rows.
    expect(conversationSidekickMentions(undefined, [], [draft, published]).map((sidekick) => sidekick.name))
      .toEqual(['Triage']);
    // The owned list vouches for an unavailable one, and keeps its status.
    expect(conversationSidekickMentions([{ id: MINE, name: 'Half-built', description: '', status: 'paused' }], [draft], [])
      .map((sidekick) => sidekick.status)).toEqual(['paused', undefined]);
  });
});
