import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useOpenReadReport } from './open-read-report';

describe('useOpenReadReport', () => {
  it('owes one report per open of a conversation, and again after another was opened', () => {
    const { rerender, result } = renderHook(({ address }) => useOpenReadReport(address), { initialProps: { address: 'canvas-1:0' } });
    expect(result.current.reported()).toBe(false);
    result.current.markReported();
    expect(result.current.reported()).toBe(true);
    // A reconnect or a re-render of the same conversation is the same open.
    rerender({ address: 'canvas-1:0' });
    expect(result.current.reported()).toBe(true);
    rerender({ address: 'canvas-2:0' });
    expect(result.current.reported()).toBe(false);
    result.current.markReported();
    rerender({ address: 'canvas-1:0' });
    expect(result.current.reported()).toBe(false);
  });
});
