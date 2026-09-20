import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MessageCardStack } from '@rally/ui/components/message-card-stack';
it('keeps sent cards read-only and offers retry only for uncertain outcomes', () => {
  const onSend = vi.fn();
  render(<MessageCardStack cards={[
    { id: '1', participant: 'Ada', destination: 'Launch', text: 'First', state: 'sent', canSend: false },
    { id: '2', participant: 'Ada', destination: 'Launch', text: 'Second', state: 'unknown', canSend: true },
  ]} participants={[]} destinations={() => []} onEdit={vi.fn()} onSend={onSend} onRemove={vi.fn()} onAdd={vi.fn()} />);
  expect(screen.getByText('Sent')).toBeInTheDocument();
  expect(screen.getAllByRole('textbox').every(input => input.hasAttribute('readonly'))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry same message' }));
  expect(onSend).toHaveBeenCalledWith('2');
  expect(screen.getAllByRole('button', { name: 'Retry same message' })).toHaveLength(1);
});
