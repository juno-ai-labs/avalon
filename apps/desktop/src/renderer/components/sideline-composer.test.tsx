import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MESSAGE_MAX_CHARACTERS, SidelineCatalogSchema } from '@rally/contracts';
import { ErrorNoticeProvider } from '@rally/ui/components/error-notice';
import { SidelineComposer, type SidelineCardModel } from '@rally/ui/components/sideline-composer';

it('acknowledges an overlong Sideline message and keeps its draft and Send guard', () => {
  const destination = { workstreamId: '00000000-0000-7000-8000-00000000d005', substreamId: '0', label: 'Launch', workstreamLabel: 'Launch' };
  const catalog = SidelineCatalogSchema.parse({
    workspace: { id: '00000000-0000-7000-8000-00000000d001', name: 'Northstar' },
    operator: { userId: '00000000-0000-7000-8000-00000000d002', name: 'Jordan' },
    participants: [{ userId: '00000000-0000-7000-8000-00000000d003', name: 'Priya', avatarUrl: null, destinations: [destination] }],
  });
  const onSend = vi.fn();
  const model: SidelineCardModel = {
    id: 'card', idempotencyKey: '00000000-0000-7000-8000-00000000d004', representedUserId: catalog.participants[0]!.userId,
    workstreamId: destination.workstreamId, substreamId: destination.substreamId, message: 'Draft', state: 'idle',
  };
  const composer = (message: string) => <SidelineComposer catalog={catalog} workspaceName="Northstar" operatorName="Jordan"
    cards={[{ ...model, message }]} status="ready" onAdd={vi.fn()} onRemove={vi.fn()} onChange={vi.fn()} onSend={onSend}
    onRetryCatalog={vi.fn()} onOpenInRally={vi.fn()} />;
  const view = render(composer('Draft'), { wrapper: ErrorNoticeProvider });
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();

  const tooLong = 'x'.repeat(MESSAGE_MAX_CHARACTERS + 1);
  view.rerender(composer(tooLong));
  expect(screen.getByRole('alertdialog')).toHaveTextContent('This message is over 100,000 characters, please shorten it.');
  expect(screen.getByRole('alertdialog').querySelector('[aria-label="Close dialog"]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(tooLong);
  const send = screen.getByRole('button', { name: 'Send' });
  expect(send).toBeDisabled();
  fireEvent.click(send);
  expect(onSend).not.toHaveBeenCalled();
});
