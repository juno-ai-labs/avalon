import * as Tooltip from '@radix-ui/react-tooltip';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COPY_FEEDBACK_MS } from '../lib/use-copy';
import { CopyButton, CopyField } from './copy-button';

const copyText = vi.hoisted(() => vi.fn<(text: string) => Promise<void>>(async () => undefined));
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ copyText }),
  desktopServicesAvailable: () => false,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  copyText.mockReset().mockResolvedValue(undefined);
});

function show(element: React.ReactNode) {
  return render(<Tooltip.Provider>{element}</Tooltip.Provider>);
}

describe('CopyButton', () => {
  it('is an icon named by its label, and says so in a tooltip', async () => {
    show(<CopyButton label="Copy endpoint" value="https://api.example.test/ingest" />);
    const button = screen.getByRole('button', { name: 'Copy endpoint' });
    expect(button).toHaveClass('icon-button');
    expect(button).toHaveTextContent('');
    // Focus opens a Radix tooltip without waiting out the pointer delay.
    fireEvent.focus(button);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Copy endpoint');
  });

  it('copies the value and shows the outcome in the control until it returns to idle', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onCopied = vi.fn();
    show(<CopyButton label="Copy endpoint" onCopied={onCopied} value="https://api.example.test/ingest" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy endpoint' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toHaveClass('copy-button-copied'));
    expect(copyText).toHaveBeenCalledWith('https://api.example.test/ingest');
    expect(onCopied).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('Copied.');

    act(() => { vi.advanceTimersByTime(COPY_FEEDBACK_MS); });
    expect(screen.getByRole('button', { name: 'Copy endpoint' })).not.toHaveClass('copy-button-copied');
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('says a refused write failed, keeps the control enabled, and copies on the next click', async () => {
    copyText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    show(<CopyButton label="Copy signing secret" value="whsec_one" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy signing secret' }));
    const failed = await screen.findByRole('button', { name: 'Copy failed — click to retry' });
    expect(failed).toBeEnabled();
    expect(failed).toHaveClass('copy-button-failed');
    expect(screen.getByRole('status')).toHaveTextContent('Copy failed. Try again.');

    fireEvent.click(failed);
    await screen.findByRole('button', { name: 'Copied' });
    expect(copyText).toHaveBeenCalledTimes(2);
  });

  it('writes through the clipboard it is handed and builds the value on demand', async () => {
    const surfaceCopy = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    show(<CopyButton copyText={surfaceCopy} label="Copy as CSV" value={async () => '"a"\r\n"1"'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy as CSV' }));
    await waitFor(() => expect(surfaceCopy).toHaveBeenCalledWith('"a"\r\n"1"'));
    expect(copyText).not.toHaveBeenCalled();
  });

  it('passes the rest of a button through, including disabled', () => {
    show(<CopyButton className="site-data-export" disabled label="Copy public link" value="" />);
    const button = screen.getByRole('button', { name: 'Copy public link' });
    expect(button).toBeDisabled();
    expect(button).toHaveClass('site-data-export');
  });
});

describe('CopyField', () => {
  it('shows the value read-only under its caption with the copy control beside it', async () => {
    show(<CopyField copyLabel="Copy endpoint" label="Endpoint URL" value="https://api.example.test/ingest/fireflies/1" />);
    const input = screen.getByLabelText('Endpoint URL');
    expect(input).toHaveValue('https://api.example.test/ingest/fireflies/1');
    expect(input).toHaveAttribute('readonly');
    expect(input).not.toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Copy endpoint' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith('https://api.example.test/ingest/fireflies/1'));
  });

  it('masks a secret and takes a more specific field name where the caption is ambiguous', () => {
    show(<CopyField copyLabel="Copy signing secret" inputLabel="Fireflies signing secret" label="Signing secret" secret value="whsec_one" />);
    const input = screen.getByLabelText('Fireflies signing secret');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveValue('whsec_one');
  });
});
