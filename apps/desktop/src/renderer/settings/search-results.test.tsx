import { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRevealSetting } from './search-results';
import { settings, type SettingSearchResult } from './registry';

const request: SettingSearchResult = { key: 'github:second', definition: settings.githubAccess, instanceId: 'second' };
function Harness({ target = request, loaded = true }: { target?: SettingSearchResult | null; loaded?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useRevealSetting(root, target);
  return <><input aria-label="Other field" /><div ref={root}>
    {loaded && ['first', 'second'].map((id) => <article key={id}>
      <span tabIndex={-1} data-setting-id="githubAccess" data-setting-instance={id}>{id}</span>
    </article>)}
  </div></>;
}
describe('settings reveal lifecycle', () => {
  it('reveals only the selected instance and removes its highlight on navigation', () => {
    const view = render(<Harness />);
    expect(document.activeElement).toHaveTextContent('second');
    expect(screen.getByText('first').closest('article')).not.toHaveClass('settings-search-highlight');
    view.rerender(<Harness target={null} />);
    expect(screen.getByText('second').closest('article')).not.toHaveClass('settings-search-highlight');
  });
  it('waits for a late target without crossing instance identity', async () => {
    const view = render(<Harness loaded={false} />);
    await act(async () => { view.rerender(<Harness />); });
    expect(document.activeElement).toHaveTextContent('second');
  });
  it.each(['navigation', 'interaction'] as const)('cancels pending reveal after %s', async (reason) => {
    const view = render(<Harness loaded={false} />);
    const field = screen.getByRole('textbox');
    if (reason === 'interaction') field.focus();
    else view.rerender(<Harness target={null} loaded={false} />);
    await act(async () => { view.rerender(<Harness target={reason === 'navigation' ? null : request} />); });
    expect(document.activeElement).not.toHaveAttribute('data-setting-instance', 'second');
    expect(screen.getByText('second').closest('article')).not.toHaveClass('settings-search-highlight');
  });
  it('does not move focus into an action button', () => {
    const click = vi.fn();
    function Action() {
      const root = useRef<HTMLDivElement>(null);
      useRevealSetting(root, { key: 'digestSave', definition: settings.digestSave });
      return <div ref={root}><button onClick={click}><span tabIndex={-1} data-setting-id="digestSave">Save</span></button></div>;
    }
    render(<Action />);
    expect(document.activeElement?.closest('button')).toBeNull();
    fireEvent.keyUp(document.activeElement!, { key: 'Enter' });
    expect(click).not.toHaveBeenCalled();
  });
});
