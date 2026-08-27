import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { draftWithMentionStarted, useMentionNavigation } from './use-mention-navigation';

/**
 * The three composers exercise this hook through their own popovers; this
 * harness is the same behaviour with nothing else in the frame, so the
 * invariants the composers depend on — the wrap arithmetic, the key-anchored
 * highlight, and the keys the hook refuses to take — are stated once.
 */
function Harness({ keys, onSelect }: { keys: string[]; onSelect: (index: number) => void }): React.JSX.Element {
  const navigation = useMentionNavigation(keys, onSelect);
  return (
    <div>
      <textarea aria-label="draft" onKeyDown={(event) => { navigation.handleKeyDown(event); }} />
      <div role="listbox" aria-label="options">
        {keys.map((key, index) => (
          <button aria-selected={index === navigation.activeIndex} key={key} role="option" type="button">{key}</button>
        ))}
      </div>
    </div>
  );
}

function selection(): Array<string | null> {
  return screen.getAllByRole('option').map((option) => option.getAttribute('aria-selected'));
}

describe('useMentionNavigation', () => {
  it('replaces a non-collapsed textarea selection when starting a mention', () => {
    expect(draftWithMentionStarted('Ask Samantha today', 4, 12)).toEqual({
      value: 'Ask @ today',
      caret: 5,
    });
  });

  it('wraps in both directions and selects the row Enter is on', () => {
    const onSelect = vi.fn();
    render(<Harness keys={['a', 'b', 'c']} onSelect={onSelect} />);
    const draft = screen.getByLabelText('draft');

    expect(selection()).toEqual(['true', 'false', 'false']);

    fireEvent.keyDown(draft, { key: 'ArrowUp' });
    expect(selection()).toEqual(['false', 'false', 'true']);

    fireEvent.keyDown(draft, { key: 'ArrowDown' });
    expect(selection()).toEqual(['true', 'false', 'false']);

    fireEvent.keyDown(draft, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('leaves the keys of an in-flight IME composition alone', () => {
    const onSelect = vi.fn();
    render(<Harness keys={['a', 'b']} onSelect={onSelect} />);
    const draft = screen.getByLabelText('draft');

    // The same Enter that commits a composition, and the arrows that walk an
    // IME's own candidate window: taking either loses what is being typed.
    fireEvent.keyDown(draft, { key: 'ArrowDown', isComposing: true });
    expect(selection()).toEqual(['true', 'false']);

    fireEvent.keyDown(draft, { key: 'Enter', isComposing: true });
    expect(onSelect).not.toHaveBeenCalled();

    // The legacy composition signal, for the paths that set no `isComposing`.
    fireEvent.keyDown(draft, { key: 'Enter', keyCode: 229 });
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.keyDown(draft, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('refuses every key while the list is empty, and takes none it does not own', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<Harness keys={[]} onSelect={onSelect} />);
    const draft = screen.getByLabelText('draft');

    fireEvent.keyDown(draft, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();

    rerender(<Harness keys={['a']} onSelect={onSelect} />);
    // Escape belongs to each composer, which dismisses its own popover with it.
    const escape = fireEvent.keyDown(draft, { key: 'Escape' });
    expect(escape).toBe(true);
    // Shift+Enter is the newline the composer inserts, not a selection.
    fireEvent.keyDown(draft, { key: 'Enter', shiftKey: true });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
