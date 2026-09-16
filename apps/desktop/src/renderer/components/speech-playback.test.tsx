import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SpeechPlaybackProvider, useSpeechPlayback, type SpeechApi, type SpeechPlayer } from './speech-playback';

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
});
