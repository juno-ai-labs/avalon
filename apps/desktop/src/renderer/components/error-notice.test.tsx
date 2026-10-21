import { StrictMode, useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ErrorNotice, ErrorNoticeProvider } from '@rally/ui/components/error-notice';
import { Button, Modal } from './primitives';

describe('ErrorNotice', () => {
  it('queues distinct failures, coalesces duplicates and survives its source closing', () => {
    const view = render(<StrictMode><ErrorNoticeProvider>
      <ErrorNotice>The message couldn’t be sent. Try again.</ErrorNotice>
      <ErrorNotice>The message couldn’t be sent. Try again.</ErrorNotice>
      <ErrorNotice>The attachment couldn’t be downloaded.</ErrorNotice>
    </ErrorNoticeProvider></StrictMode>);
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('The message couldn’t be sent. Try again.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close dialog' })).not.toBeInTheDocument();

    view.rerender(<StrictMode><ErrorNoticeProvider /></StrictMode>);
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('The attachment couldn’t be downloaded.');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('stays dismissed through rerenders and reports another identical failed attempt', () => {
    const failure = new Error('Save failed.');
    const surface = (occurrence: Error) => <ErrorNoticeProvider><ErrorNotice occurrence={occurrence}>Save failed.</ErrorNotice></ErrorNoticeProvider>;
    const view = render(surface(failure));
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    view.rerender(surface(failure));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    view.rerender(surface(new Error('Save failed.')));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Save failed.');
  });

  it('preserves a parent dialog and draft and returns focus after acknowledgement', async () => {
    function Editor() {
      const [open, setOpen] = useState(true);
      const [failed, setFailed] = useState(false);
      return <ErrorNoticeProvider><Modal open={open} onOpenChange={setOpen} title="Edit message">
        <textarea aria-label="Draft" defaultValue="Keep my draft" />
        <Button onClick={() => setFailed(true)}>Save</Button>
        {failed && <ErrorNotice>The edit couldn’t be saved.</ErrorNotice>}
      </Modal></ErrorNoticeProvider>;
    }
    render(<Editor />);
    const save = screen.getByRole('button', { name: 'Save' });
    save.focus();
    fireEvent.click(save);
    const error = screen.getByRole('alertdialog', { name: 'Something went wrong' });
    await waitFor(() => expect(within(error).getByRole('button', { name: 'OK' })).toHaveFocus());
    fireEvent.click(within(error).getByRole('button', { name: 'OK' }));
    expect(screen.getByRole('dialog', { name: 'Edit message' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep my draft');
    await waitFor(() => expect(save).toHaveFocus());
  });
});
