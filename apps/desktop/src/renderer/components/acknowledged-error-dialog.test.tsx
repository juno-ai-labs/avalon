import * as Tooltip from '@radix-ui/react-tooltip';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AcknowledgedErrorDialog } from './acknowledged-error-dialog';

function renderDialog(onAcknowledge = vi.fn()) {
  render(
    <Tooltip.Provider>
      <AcknowledgedErrorDialog
        error={{ title: 'Channels could not be reordered', copy: 'The channels are back in their previous order.' }}
        onAcknowledge={onAcknowledge}
      />
    </Tooltip.Provider>,
  );
  return onAcknowledge;
}

describe('AcknowledgedErrorDialog', () => {
  it('puts initial focus on OK and acknowledges its explicit action', async () => {
    const onAcknowledge = renderDialog();
    const ok = screen.getByRole('button', { name: 'OK' });

    await waitFor(() => expect(ok).toHaveFocus());
    fireEvent.click(ok);

    expect(onAcknowledge).toHaveBeenCalledOnce();
  });

  it('acknowledges dismissal with Escape', () => {
    const onAcknowledge = renderDialog();

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });

    expect(onAcknowledge).toHaveBeenCalledOnce();
  });
});
