import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationCard } from '@rally/ui/components/conversation-card';

describe('ConversationCard', () => {
  it('names the conversation with its news, draws summary and byline, and opens on click', () => {
    const onOpen = vi.fn();
    render(<ConversationCard
      conversation={{ substreamId: 'one', title: 'Pricing', unreadCount: 1 }}
      meta="Ada · 2h"
      onOpen={onOpen}
      open={false}
      summary="Compare the three plans."
    />);

    const card = screen.getByRole('button', { name: 'Pricing, 1 new' });
    expect(card).toHaveAttribute('aria-pressed', 'false');
    expect(card).toHaveTextContent('1 newPricingCompare the three plans.Ada · 2h');
    expect(screen.queryByText('Private')).not.toBeInTheDocument();
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('says Open and Needs input, and leaves out a summary it was not given', () => {
    render(<ConversationCard
      conversation={{ substreamId: 'two', title: 'Rain', needsInput: true }}
      onOpen={vi.fn()}
      open
    />);

    const card = screen.getByRole('button', { name: 'Rain, Needs input, Open' });
    expect(card).toHaveAttribute('aria-pressed', 'true');
    expect(card).toHaveTextContent(/^Needs inputRain$/u);
  });

  it('drops its news while open, but not a waiting question', () => {
    render(<ConversationCard
      conversation={{ substreamId: 'four', title: 'Hiring', unreadCount: 2, youAreMentioned: true, unseen: true, needsAttention: true }}
      onOpen={vi.fn()}
      open
    />);

    expect(screen.getByRole('button', { name: 'Hiring, Open' })).toHaveTextContent(/^Hiring$/u);
  });

  it('keeps a resolved conversation openable and exposes its state alongside new activity', () => {
    const onOpen = vi.fn();
    render(<ConversationCard
      conversation={{ substreamId: 'resolved', title: 'Pricing', resolved: true, unreadCount: 2 }}
      onOpen={onOpen}
      open={false}
    />);
    const card = screen.getByRole('button', { name: 'Pricing, Resolved, 2 new' });
    expect(card).toHaveTextContent('Resolved');
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it.each([false, true])('labels private conversations independently of resolution (resolved=%s), even without a byline', (resolved) => {
    const onOpen = vi.fn();
    render(<ConversationCard
      conversation={{ substreamId: 'private', title: 'Planning', resolved }}
      onOpen={onOpen}
      open={false}
      private
    />);

    const card = screen.getByRole('button', { name: resolved ? 'Planning, Resolved, Private' : 'Planning, Private' });
    expect(screen.getByText('Private')).toBeVisible();
    expect(card).toHaveTextContent(resolved ? 'PlanningResolvedPrivate' : 'PlanningPrivate');
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('stands a skeleton in for the title while Rally names it', () => {
    render(<ConversationCard
      conversation={{ substreamId: 'three', title: 'New thread', naming: true }}
      onOpen={vi.fn()}
      open={false}
    />);

    expect(screen.getByRole('button', { name: 'Rally is choosing a name' })).not.toHaveTextContent('New thread');
  });
});
