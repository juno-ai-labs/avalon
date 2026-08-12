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

  it('commits a draft typed before the cache answered, when the composer unmounts', async () => {
    // Nothing is awaited between the render and the edit, so the hydration read
    // cannot have resolved: the save effect is still standing down and the
    // unmount flush has nothing armed to write. This ordering used to lose the
    // draft outright, and it reached CI as an intermittent failure of the test
    // below — which types after an `await` and so usually hydrates first.
    const { result, unmount } = renderHook(() => useDraftText(draftKey));
    act(() => result.current.setText('typed before the cache answered'));

    unmount();

    await waitFor(async () =>
      expect((await readDraftText(draftKey))?.text).toBe('typed before the cache answered'));
  });

  it('does not restamp a draft it only read, so the expiry clock keeps running', async () => {
    await writeDraftText(draftKey, 'written once');
    const writtenAt = (await readDraftText(draftKey))!.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const { result, unmount } = renderHook(() => useDraftText(draftKey));
    await waitFor(() => expect(result.current.text).toBe('written once'));
    unmount();

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await readDraftText(draftKey))?.updatedAt).toBe(writtenAt);
  });

  it('leaves nothing behind when a released draft is re-keyed onto another', async () => {
    // The new-automation screen carries the sentence typed while a turn was
    // compiling onto the draft that turn created. Carrying it is a copy unless
    // the original goes, and both ways it can be left behind are covered here:
    // the debounce has already written this one to the cache, and the pending
    // write would be flushed a second time by the key change.
    const { result, rerender } = renderHook(({ key }) => useDraftText(key), { initialProps: { key: draftKey } });
    await waitFor(() => expect(result.current.text).toBe(''));
    act(() => result.current.setText('typed while the turn compiled'));
    await waitFor(async () => expect((await readDraftText(draftKey))?.text).toBe('typed while the turn compiled'));

    // Exactly what the screen does: take the draft, then re-key in the same
    // batch, then write it back under the new key.
    act(() => {
      result.current.releaseDraft();
      rerender({ key: 'new-automation:workspace:draft-1' });
    });
    act(() => result.current.setText('typed while the turn compiled'));

    await waitFor(async () =>
      expect((await readDraftText('new-automation:workspace:draft-1'))?.text).toBe('typed while the turn compiled'));
    // The sentence moved. The key it was typed under — which the blank launcher
    // shares — must not still be holding it.
    expect(await readDraftText(draftKey)).toBeNull();
  });

  it('leaves nothing behind when a released draft never reached the cache', async () => {
    // The same move, but re-keyed inside the save debounce — which is the real
    // ordering, because the turn settles the moment the model answers. Nothing
    // is on disk yet, so clearing the key is a no-op and the only thing that can
    // leave the sentence behind is the pending write the key change flushes.
    const { result, rerender } = renderHook(({ key }) => useDraftText(key), { initialProps: { key: draftKey } });
    await waitFor(() => expect(result.current.text).toBe(''));

    // Committed on its own so the save effect actually arms the debounce —
    // batching the edit with the release leaves nothing pending and tests
    // nothing. Deliberately not awaited: the write must still be in the timer.
    act(() => result.current.setText('typed while the turn compiled'));

    act(() => {
      result.current.releaseDraft();
      rerender({ key: 'new-automation:workspace:draft-1' });
    });
    act(() => result.current.setText('typed while the turn compiled'));

    await waitFor(async () =>
      expect((await readDraftText('new-automation:workspace:draft-1'))?.text).toBe('typed while the turn compiled'));
    // Long enough that a flushed debounce would have landed by now.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await readDraftText(draftKey)).toBeNull();
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
