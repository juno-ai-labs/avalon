import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SuggestionChip, suggestionExcerpt, SUGGESTION_EXCERPT_CHARACTERS } from '@rally/ui/components/conversation-suggestion';
import { MergeResponseCard } from '@rally/ui/components/merge-response-card';

describe('suggestionExcerpt', () => {
  it('quotes the first line, cut by characters with the ellipsis inside the closing quote', () => {
    expect(suggestionExcerpt('Keep the discount.\nMore below.')).toBe('“Keep the discount.…”');
    const long = 'a'.repeat(SUGGESTION_EXCERPT_CHARACTERS + 10);
    expect(suggestionExcerpt(long)).toBe(`“${'a'.repeat(SUGGESTION_EXCERPT_CHARACTERS)}…”`);
    expect(suggestionExcerpt('Short and whole')).toBe('“Short and whole”');
    expect(suggestionExcerpt(`${'b'.repeat(SUGGESTION_EXCERPT_CHARACTERS - 1)} tail`)).toBe(`“${'b'.repeat(SUGGESTION_EXCERPT_CHARACTERS - 1)}…”`);
  });
});

describe('SuggestionChip', () => {
  it('draws the title, the sentence and the excerpt, and dismisses through either control', () => {
    const onAct = vi.fn();
    const onDismiss = vi.fn();
    render(<SuggestionChip
      action={{ label: 'Merge', onAct }}
      excerpt={'“Keep it.”'}
      kind="merge_up"
      label="Suggestion: merge to Pricing"
      onDismiss={onDismiss}
      pending={false}
      sentence="This might be a good time to merge this back into Pricing."
      title={<>Merge to <strong>Pricing</strong></>}
    />);
    const chip = screen.getByRole('group', { name: 'Suggestion: merge to Pricing' });
    expect(chip.textContent).toContain('Merge to Pricing');
    expect(chip.textContent).toContain('“Keep it.”');
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss suggestion' }));
    expect(onAct).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('while the draft is pending draws a skeleton, disables the action and keeps Dismiss live', () => {
    const onAct = vi.fn();
    render(<SuggestionChip
      action={{ label: 'Start', onAct }}
      excerpt={null}
      kind="start_breakout"
      label="Suggestion: breakout"
      onDismiss={() => undefined}
      pending
      sentence="Want to break this out?"
      title="Breakout"
    />);
    expect(screen.getByRole('status', { name: 'Rally is drafting the words' })).toBeTruthy();
    const start = screen.getByRole('button', { name: 'Start' });
    expect(start).toBeDisabled();
    fireEvent.click(start);
    expect(onAct).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Dismiss suggestion' })).toBeEnabled();
  });
});

describe('MergeResponseCard', () => {
  function card(overrides: Partial<Parameters<typeof MergeResponseCard>[0]> = {}) {
    const props = {
      audience: 'The 3 people in Pricing will see this.',
      embeds: [],
      label: 'Merge to Pricing',
      mergedBy: <span>Morgan</span>,
      onCancel: vi.fn(),
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      source: { mark: <span>↳</span>, title: 'Annual discount' },
      submitting: false,
      targetName: 'Pricing',
      targetPill: <span>Merge to thread</span>,
      time: <span>now</span>,
      value: 'Keep the discount.',
      ...overrides,
    };
    render(<MergeResponseCard {...props} />);
    return props;
  }

  it('merges on Enter, breaks a line on Shift+Enter, cancels on Escape', () => {
    const props = card();
    const input = screen.getByRole('textbox', { name: 'Merge note' });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(props.onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onSubmit).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(props.onCancel).toHaveBeenCalledOnce();
  });

  it('keeps Merge disabled on empty words and while submitting, and removes an embed through its pill', () => {
    const onRemove = vi.fn();
    card({ value: '   ', embeds: [{ id: 'r1', title: 'Retention table', onRemove }] });
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Retention table' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('reads as the parent will draw it: the source, who merged, the words', () => {
    card();
    const article = screen.getByRole('article', { name: 'Merge to Pricing' });
    expect(article.textContent).toContain('Annual discount');
    expect(article.textContent).toContain('merged by');
    expect(article.textContent).toContain('Morgan');
    expect(screen.getByRole('textbox', { name: 'Merge note' })).toHaveValue('Keep the discount.');
    expect(article.textContent).toContain('Merge, as Pricing will see it');
  });

  it('prompts an empty card with the parent it will land in', () => {
    card({ value: '' });
    expect(screen.getByRole('textbox', { name: 'Merge note' })).toHaveAttribute('placeholder', 'Write what Pricing should know. Embed an artifact with [Title](resource://id).');
  });
});
