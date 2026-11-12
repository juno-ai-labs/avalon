import "../../../../../tests/isolated-region";
import * as Tooltip from '@radix-ui/react-tooltip';
import { ErrorNoticeProvider } from '@rally/ui/components/error-notice';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RunFailureNotice } from './conversation-surface';

const usageMessage = "Your organization has used this week's included usage. An administrator can turn on overage billing in Organization settings, or usage resumes when the weekly allowance resets";

function renderNotice(code: string, message: string) {
  const onRetry = vi.fn();
  const onOpenUsageSettings = vi.fn();
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><Tooltip.Provider><ErrorNoticeProvider>
    <RunFailureNotice automatic={false} code={code} message={message} onOpenUsageSettings={onOpenUsageSettings}
      onRetry={onRetry} requestId="01a1d1d9-7304-7cce-8635-bd885cc772d1" retrying={false} />
  </ErrorNoticeProvider></Tooltip.Provider></QueryClientProvider>);
  return { onRetry, onOpenUsageSettings };
}

describe('a failed run whose remedy is a setting', () => {
  it('offers the usage settings first when the weekly allowance is spent', () => {
    const { onOpenUsageSettings, onRetry } = renderNotice('usage_allowance_exhausted', usageMessage);
    const actions = screen.getAllByRole('button').map((button) => button.textContent);
    expect(actions).toEqual(['Run details', 'Open usage settings', 'Retry']);

    fireEvent.click(screen.getByRole('button', { name: 'Open usage settings' }));
    expect(onOpenUsageSettings).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Run details' }));
    expect(screen.getByRole('alertdialog', { name: 'Usage limit reached' })).toBeTruthy();
  });

  it('keeps Retry as the only action for any other failure', () => {
    renderNotice('run_state_persistence_failed', "Rally could not save this run's progress.");
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Run details', 'Retry']);
    fireEvent.click(screen.getByRole('button', { name: 'Run details' }));
    expect(screen.getByRole('alertdialog', { name: 'Run failed' })).toBeTruthy();
  });
});
