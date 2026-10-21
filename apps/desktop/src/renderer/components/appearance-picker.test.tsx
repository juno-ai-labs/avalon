import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppearancePicker } from './appearance-picker';
import { WorkstreamGlyph } from './workstream-glyph';

/**
 * The work stream's own arrangement of the shared picker. The behaviour under
 * test belongs to the picker rather than to either caller, so it is exercised
 * through one of them rather than through a component built for the test.
 */
function WorkstreamAppearancePicker(
  props: Omit<React.ComponentProps<typeof AppearancePicker>, 'label' | 'renderGlyph'>,
): React.JSX.Element {
  return <AppearancePicker
    {...props}
    label="Change channel icon and color"
    renderGlyph={(appearance) => <WorkstreamGlyph appearance={appearance} id={props.id} />}
  />;
}

function openPicker(): void {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Change channel icon and color' }), { key: 'Enter' });
}

describe('appearance picker', () => {
  it('lays the catalog out in eight sections with a tab for each, and saves a choice from any of them', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<WorkstreamAppearancePicker id="room" appearance={{ icon: 'atom', color: 'blue' }} onChange={onChange} />);
    openPicker();
    await screen.findByRole('menu');
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((tab) => tab.getAttribute('aria-label'))).toEqual([
      'Planning', 'Docs & writing', 'Learning', 'People & talk', 'Data & money',
      'Build & tech', 'Places & nature', 'Life & fun',
    ]);
    expect(screen.getByRole('menuitem', { name: 'Planning' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('region', { name: 'Life & fun' })).toContainElement(screen.getByRole('menuitemradio', { name: 'Drum' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Drum' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ icon: 'drum' }));
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(253 + 14);
  });

  it('draws the catalog in the chosen colour, and redraws it when the colour changes', async () => {
    render(<WorkstreamAppearancePicker id="room" appearance={{ icon: 'atom', color: 'blue' }} onChange={vi.fn().mockResolvedValue(undefined)} />);
    openPicker();
    const drum = await screen.findByRole('menuitemradio', { name: 'Drum' });
    expect(drum.querySelector('svg')).toHaveAttribute('stroke', 'var(--av-sys-color-project-ink-blue)');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Green' }));
    expect(drum.querySelector('svg')).toHaveAttribute('stroke', 'var(--av-sys-color-project-ink-green)');
  });

  it('draws an icon the catalog no longer offers, and offers nothing in its place', async () => {
    render(<WorkstreamAppearancePicker id="room" appearance={{ icon: 'workflow', color: 'blue' }} onChange={vi.fn()} />);
    openPicker();
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitemradio', { name: 'Workflow' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Icon' })).queryAllByRole('menuitemradio', { checked: true })).toHaveLength(0);
  });

  it('keeps the popup open and submits rapid choices without a save', async () => {
    let finish!: () => void;
    const onChange = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
    render(<WorkstreamAppearancePicker id="room" appearance={{ icon: 'atom', color: 'blue' }} onChange={onChange} />);
    openPicker();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Purple' }));
    expect(screen.getByRole('menuitemradio', { name: 'Purple' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Rocket' }));
    expect(screen.getByRole('menuitemradio', { name: 'Rocket' })).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(onChange).toHaveBeenNthCalledWith(1, { color: 'purple' });
    await act(async () => finish());
    await waitFor(() => expect(onChange).toHaveBeenNthCalledWith(2, { icon: 'rocket' }));
    expect(screen.getByRole('menu')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Change channel icon and color' })).toHaveFocus();
  });

  it('restores server state and reports a failed save', async () => {
    render(<WorkstreamAppearancePicker id="room" appearance={{ icon: 'atom', color: 'blue' }} onChange={vi.fn().mockRejectedValue(new Error('offline'))} />);
    openPicker();
    // A different swatch than the stored one, or there is no optimistic state to
    // roll back and the final assertion passes whether or not the failed choice
    // is retired.
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Red' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Couldn’t update');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.getByRole('menuitemradio', { name: 'Red' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menuitemradio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
  });
  it('keeps a saved preview through unrelated metadata and retires it when the value arrives', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const props = { id: 'room', onChange };
    const { rerender } = render(<WorkstreamAppearancePicker {...props} appearance={{ icon: 'atom', color: 'blue' }} />);
    openPicker();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Purple' }));
    await act(async () => {});
    rerender(<WorkstreamAppearancePicker {...props} appearance={{ icon: 'atom', color: 'blue' }} />);
    expect(screen.getByRole('menuitemradio', { name: 'Purple' })).toHaveAttribute('aria-checked', 'true');
    rerender(<WorkstreamAppearancePicker {...props} appearance={{ icon: 'atom', color: 'purple' }} />);
    rerender(<WorkstreamAppearancePicker {...props} appearance={{ icon: 'atom', color: 'blue' }} />);
    expect(screen.getByRole('menuitemradio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
  });

  it('removes only the failed choice and ignores its superseded error', async () => {
    let fail!: (error: Error) => void;
    const onChange = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }))
      .mockResolvedValue(undefined);
    render(<WorkstreamAppearancePicker id="room" appearance={{ icon: 'atom', color: 'blue' }} onChange={onChange} />);
    openPicker();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Purple' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Rocket' }));
    await act(async () => { fail(new Error('offline')); });
    expect(screen.getByRole('menuitemradio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Rocket' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('does not show a stale failure when reopened', async () => {
    let fail!: (error: Error) => void;
    render(<WorkstreamAppearancePicker id="room" appearance={{ icon: 'atom', color: 'blue' }}
      onChange={() => new Promise<void>((_resolve, reject) => { fail = reject; })} />);
    openPicker();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Purple' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await act(async () => { fail(new Error('offline')); });
    openPicker();
    expect(await screen.findByRole('menuitemradio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows no swatch for a colour reserved to accounts, but still renders a channel holding one', () => {
    // `black` is storable and not offered. A work stream set to it before the
    // picker stopped listing it must still open the picker without throwing —
    // it simply has nothing checked, and picking anything moves it onto a hue.
    render(<WorkstreamAppearancePicker id="room" appearance={{ icon: 'atom', color: 'black' }} onChange={vi.fn()} />);
    openPicker();

    expect(screen.queryByRole('menuitemradio', { name: 'Black' })).not.toBeInTheDocument();
    // Scoped to the colour group: the icon group shares the menuitemradio role,
    // and its selection is unrelated.
    const colours = document.querySelector('.appearance-picker-colors');
    const checked = [...(colours?.querySelectorAll('[role="menuitemradio"][aria-checked="true"]') ?? [])];
    expect(checked).toHaveLength(0);
    expect(screen.getByRole('menuitemradio', { name: 'Blue' })).toBeInTheDocument();
  });

});
