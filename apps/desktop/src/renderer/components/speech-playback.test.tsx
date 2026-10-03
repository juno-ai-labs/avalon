import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SpeechPlaybackProvider, useSpeechPlayback, type SpeechApi, type SpeechPlayer } from './speech-playback';
import { CollaborationSessionProvider } from '../lib/collaboration-session';

function hangingPlayer(): SpeechPlayer {
  return {
    prepare: vi.fn(async () => undefined),
    play: vi.fn(async () => new Promise<void>(() => undefined)),
    stop: vi.fn(),
  };
}

function SpeakButtons() {
  const speech = useSpeechPlayback()!;
  return (
    <>
      <button type="button" onClick={() => speech.speak('message-one', 'First')}>One</button>
      <button type="button" onClick={() => speech.speak('message-two', 'Second')}>Two</button>
    </>
  );
}

describe('SpeechPlaybackProvider mutex', () => {
  it('stops the active clip before another message starts speaking', async () => {
    const players: SpeechPlayer[] = [];
    const streamMessageSpeech = vi.fn<SpeechApi['streamMessageSpeech']>(
      async () => new ReadableStream<Uint8Array>(),
    );
    const api = { streamMessageSpeech } satisfies SpeechApi;
    render(
      <SpeechPlaybackProvider
        api={api}
        createPlayer={() => {
          const player = hangingPlayer();
          players.push(player);
          return player;
        }}
      >
        <SpeakButtons />
      </SpeechPlaybackProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'One' }));
    await waitFor(() => expect(players).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Two' }));
    await waitFor(() => expect(players).toHaveLength(2));

    expect(players[0]?.stop).toHaveBeenCalled();
    expect(streamMessageSpeech.mock.calls.map(([markdown]) => markdown)).toEqual(['First', 'Second']);
  });

  it('aborts the speech request when prepare fails', async () => {
    let seen: AbortSignal | undefined;
    const streamMessageSpeech = vi.fn<SpeechApi['streamMessageSpeech']>(
      async (_markdown, signal) => {
        seen = signal;
        return new Promise<ReadableStream<Uint8Array>>(() => undefined);
      },
    );
    render(
      <SpeechPlaybackProvider
        api={{ streamMessageSpeech }}
        createPlayer={() => ({
          prepare: vi.fn(async () => {
            throw new Error('no audio context');
          }),
          play: vi.fn(async () => undefined),
          stop: vi.fn(),
        })}
      >
        <SpeakButtons />
      </SpeechPlaybackProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'One' }));
    await waitFor(() => expect(seen?.aborted).toBe(true));
  });
});

describe('speech for a guest', () => {
  it('offers a guest no speech, because the speech route refuses them', () => {
    const api = { streamMessageSpeech: vi.fn<SpeechApi['streamMessageSpeech']>() } satisfies SpeechApi;
    function Probe() { return <span>{useSpeechPlayback() ? 'offered' : 'withheld'}</span>; }
    const tree = (accessClass?: 'guest') => (
      <CollaborationSessionProvider api={null} session={{
        user: { id: 'user', email: 'person@example.test', name: 'Person' },
        workspace: { id: 'workspace', name: 'Design', region: 'global', role: accessClass ? null : 'member', ...(accessClass ? { accessClass } : {}) },
        expiresAt: '2099-01-01T00:00:00.000Z', apiBaseUrl: 'https://api.rallywith.ai',
      }}>
        <SpeechPlaybackProvider api={api}><Probe /></SpeechPlaybackProvider>
      </CollaborationSessionProvider>
    );
    const view = render(tree());
    expect(screen.getByText('offered')).toBeInTheDocument();
    view.rerender(tree('guest'));
    expect(screen.getByText('withheld')).toBeInTheDocument();
  });
});
