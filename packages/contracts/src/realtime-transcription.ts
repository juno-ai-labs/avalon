// Existing Rally proxy frame-size bound, shared with audio senders.
export const TRANSCRIPTION_MAX_FRAME_CHARACTERS = 256_000;

// How long a transcription socket ticket is valid from signing. The Worker
// signs with it and the client reads it to decide whether a ticket fetched
// ahead of a recording is still worth presenting.
export const TRANSCRIPTION_TICKET_LIFETIME_SECONDS = 60;

// Match the PCM capture worklet's 2,400 samples at 24 kHz. This is a
// transport cadence, not an audio playback speed or a new admission limit.
export const TRANSCRIPTION_AUDIO_SEND_INTERVAL_MS = 100;
const appendEnvelopeCharacters = JSON.stringify({ type: 'input_audio_buffer.append', audio: '' }).length;
// Base64 groups three bytes into four characters. Round down to whole PCM16 samples.
export const TRANSCRIPTION_MAX_APPEND_BYTES = Math.floor(
  Math.floor((TRANSCRIPTION_MAX_FRAME_CHARACTERS - appendEnvelopeCharacters) / 4) * 3 / 2,
) * 2;
