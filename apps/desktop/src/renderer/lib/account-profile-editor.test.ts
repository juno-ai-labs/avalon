import { describe, expect, it, vi } from 'vitest';
import type { AccountOnboarding, UpdateAccountOnboarding } from '@rally/contracts';
import { AccountProfileEditor } from './account-profile-editor';

const original: AccountOnboarding = { eligible: false, introduced: true, revision: 1,
  presentation: { displayName: 'Alex Morgan', initials: 'AM', color: 'blue', avatar: 'circle', revision: 1 } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function saved(input: UpdateAccountOnboarding): AccountOnboarding {
  return { ...original, revision: input.expectedRevision + 1,
    presentation: { ...original.presentation!, ...input.presentation, revision: input.expectedRevision + 1 } };
}

describe('automatic profile writes', () => {
  it('previews immediately, coalesces typing and serializes revisions without reverting later edits', async () => {
    const first = deferred<AccountOnboarding>();
    const write = vi.fn<(input: UpdateAccountOnboarding) => Promise<AccountOnboarding>>()
      .mockImplementationOnce(() => first.promise).mockImplementation(async (input) => saved(input));
    const committed = vi.fn();
    const editor = new AccountProfileEditor('Alex Morgan', write, async () => original, committed);
    editor.refresh(original);
    editor.update({ displayName: 'Alex R' });
    editor.update({ displayName: 'Alex Rivera' });
    editor.update({ initials: 'AR', color: 'violet' });
    expect(editor.getSnapshot()).toMatchObject({ saving: true, profile: { displayName: 'Alex Rivera', initials: 'AR', color: 'violet' } });
    expect(write).toHaveBeenCalledTimes(1);
    first.resolve(saved(write.mock.calls[0]![0]));
    await vi.waitFor(() => expect(editor.getSnapshot().saving).toBe(false), { timeout: 5_000 });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![0]).toEqual({ expectedRevision: 2,
      presentation: { displayName: 'Alex Rivera', initials: 'AR', color: 'violet', avatar: 'circle' } });
    expect(committed.mock.lastCall?.[0]).toMatchObject({ revision: 3, presentation: { displayName: 'Alex Rivera', initials: 'AR', color: 'violet' } });
  });

  it('keeps spaces in acknowledged text without resending or moving the input caret', async () => {
    const write = vi.fn(async (input: UpdateAccountOnboarding) => saved(input));
    const editor = new AccountProfileEditor('Alex Morgan', write, async () => original, () => {});
    editor.refresh(original);
    editor.update({ displayName: 'Alex ' });
    await vi.waitFor(() => expect(editor.getSnapshot().saving).toBe(false));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0].presentation?.displayName).toBe('Alex');
    expect(editor.getSnapshot().profile.displayName).toBe('Alex ');
    editor.update({ displayName: editor.getSnapshot().profile.displayName + 'Rivera' });
    await vi.waitFor(() => expect(editor.getSnapshot().saving).toBe(false));
    expect(write.mock.lastCall?.[0].presentation?.displayName).toBe('Alex Rivera');
    expect(editor.getSnapshot().profile.displayName).toBe('Alex Rivera');
  });

  it('keeps the profile identity stable across save-status updates', async () => {
    const pending = deferred<AccountOnboarding>();
    const editor = new AccountProfileEditor('Alex Morgan', () => pending.promise, async () => original, () => {});
    editor.refresh(original);
    editor.update({ color: 'rose' });
    const profile = editor.getSnapshot().profile;
    pending.resolve({ ...original, revision: 2, presentation: { ...original.presentation!, color: 'rose', revision: 2 } });
    await vi.waitFor(() => expect(editor.getSnapshot().saving).toBe(false));
    expect(editor.getSnapshot().profile).toBe(profile);
  });

  it('keeps invalid drafts local and automatically saves when corrected', async () => {
    const write = vi.fn(async (input: UpdateAccountOnboarding) => saved(input));
    const editor = new AccountProfileEditor('Alex Morgan', write, async () => original, () => {});
    editor.refresh(original);
    editor.update({ displayName: '' });
    expect(write).not.toHaveBeenCalled();
    expect(editor.getSnapshot()).toMatchObject({ error: 'Enter a name.', profile: { displayName: '' } });
    editor.update({ displayName: 'Alex Rivera' });
    await vi.waitFor(() => expect(editor.getSnapshot().saving).toBe(false), { timeout: 5_000 });
    expect(editor.getSnapshot()).toMatchObject({ error: null, profile: { displayName: 'Alex Rivera' } });
  });

  it('retains failed edits and retries against the refreshed revision without overwriting other fields', async () => {
    const write = vi.fn<(input: UpdateAccountOnboarding) => Promise<AccountOnboarding>>()
      .mockRejectedValueOnce(new Error('Profile changed in another session')).mockImplementation(async (input) => saved(input));
    const latest: AccountOnboarding = { ...original, revision: 4, presentation: { ...original.presentation!, color: 'rose', revision: 4 } };
    const editor = new AccountProfileEditor('Alex Morgan', write, async () => latest, () => {});
    editor.refresh(original);
    editor.update({ displayName: 'Alex Rivera' });
    await vi.waitFor(() => expect(editor.getSnapshot().error).toBe('Profile changed in another session'), { timeout: 5_000 });
    expect(editor.getSnapshot().profile).toMatchObject({ displayName: 'Alex Rivera', color: 'rose' });
    editor.retry();
    await vi.waitFor(() => expect(editor.getSnapshot().saving).toBe(false), { timeout: 5_000 });
    expect(write.mock.lastCall?.[0]).toMatchObject({ expectedRevision: 4, presentation: { displayName: 'Alex Rivera', color: 'rose' } });
  });

  it('continues pending writes after the settings fields unsubscribe and accepts streamed revisions', async () => {
    const first = deferred<AccountOnboarding>();
    const committed = vi.fn();
    const write = vi.fn<(input: UpdateAccountOnboarding) => Promise<AccountOnboarding>>()
      .mockImplementationOnce(() => first.promise).mockImplementation(async (input) => saved(input));
    const editor = new AccountProfileEditor('Alex Morgan', write, async () => original, committed);
    editor.refresh(original);
    const unsubscribe = editor.subscribe(() => {});
    editor.update({ color: 'rose' });
    editor.update({ initials: 'AR' });
    unsubscribe();
    first.resolve(saved(write.mock.calls[0]![0]));
    await vi.waitFor(() => expect(editor.getSnapshot().saving).toBe(false), { timeout: 5_000 });
    expect(committed.mock.lastCall?.[0].presentation).toMatchObject({ color: 'rose', initials: 'AR' });
    editor.refresh({ ...original, revision: 8, presentation: { ...original.presentation!, displayName: 'Remote Name', revision: 8 } });
    editor.refresh(original);
    expect(editor.getSnapshot().profile.displayName).toBe('Remote Name');
  });
  it('does not send queued edits after its account signs out', async () => {
    const first = deferred<AccountOnboarding>();
    const write = vi.fn<(input: UpdateAccountOnboarding) => Promise<AccountOnboarding>>(() => first.promise);
    const committed = vi.fn();
    const editor = new AccountProfileEditor('Alex Morgan', write, async () => original, committed);
    editor.refresh(original);
    editor.update({ color: 'rose' });
    editor.update({ initials: 'AR' });
    editor.stop();
    first.resolve(saved(write.mock.calls[0]![0]));
    await vi.waitFor(() => expect(editor.getSnapshot().saving).toBe(false), { timeout: 5_000 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(committed).not.toHaveBeenCalled();
  });

});
