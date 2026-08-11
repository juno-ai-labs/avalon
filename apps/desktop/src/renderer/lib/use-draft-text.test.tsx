import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllDrafts, readDraftText, writeDraftText } from './draft-cache';
import { useDraftText } from './use-draft-text';

const draftKey = 'workstream:019fcc00-0000-7000-8000-0000000000ff';

describe('useDraftText', () => {
  beforeEach(() => clearAllDrafts());

  it('restores the cached text and mentions for its key', async () => {
    await writeDraftText(draftKey, 'half a thought', [
      { type: 'person', label: 'Ada', userId: 'user-1', connectorType: null },
    ]);

    const { result } = renderHook(() => useDraftText(draftKey));

    await waitFor(() => expect(result.current.text).toBe('half a thought'));
    expect(result.current.mentions.map((mention) => mention.label)).toEqual(['Ada']);
  });

  it('caches what the user types', async () => {
    const { result } = renderHook(() => useDraftText(draftKey));
    await waitFor(() => expect(result.current.text).toBe(''));

    act(() => result.current.setText('half a thought'));

    await waitFor(async () => expect((await readDraftText(draftKey))?.text).toBe('half a thought'));
  });

  it('drops the cached draft once the composer is emptied', async () => {
    const { result } = renderHook(() => useDraftText(draftKey));
    await waitFor(() => expect(result.current.text).toBe(''));
    act(() => result.current.setText('half a thought'));
    await waitFor(async () => expect(await readDraftText(draftKey)).not.toBeNull());

    act(() => result.current.setText(''));

    await waitFor(async () => expect(await readDraftText(draftKey)).toBeNull());
  });

  it('keeps text typed before the cached draft has loaded', async () => {
    await writeDraftText(draftKey, 'stale draft');
    const { result } = renderHook(() => useDraftText(draftKey));

    act(() => result.current.setText('what the user meant'));

    await waitFor(async () => expect((await readDraftText(draftKey))?.text).toBe('what the user meant'));
    expect(result.current.text).toBe('what the user meant');
  });

  it('commits an unsaved draft when the composer unmounts', async () => {
    const { result, unmount } = renderHook(() => useDraftText(draftKey));
    await waitFor(() => expect(result.current.text).toBe(''));
    act(() => result.current.setText('typed and gone'));

    unmount();

    await waitFor(async () => expect((await readDraftText(draftKey))?.text).toBe('typed and gone'));
  });

  it('swaps drafts when the key changes and keeps each one separate', async () => {
    await writeDraftText('workstream:other', 'the other draft');
    const { result, rerender } = renderHook(({ key }) => useDraftText(key), { initialProps: { key: draftKey } });
    act(() => result.current.setText('this draft'));
    await waitFor(async () => expect(await readDraftText(draftKey)).not.toBeNull());

    rerender({ key: 'workstream:other' });

    await waitFor(() => expect(result.current.text).toBe('the other draft'));
    rerender({ key: draftKey });
    await waitFor(() => expect(result.current.text).toBe('this draft'));
  });
});
