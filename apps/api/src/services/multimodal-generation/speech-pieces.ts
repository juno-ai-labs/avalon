/**
 * Long speech, made from pieces the speech model accepts.
 *
 * `gpt-4o-mini-tts` reads at most 4,096 characters per request, so an
 * episode-length script has to be split, recorded piece by piece, and joined.
 * That used to be the model's job, in a skill, with ffmpeg in a sandbox: many
 * steps to get right, and a voice that could drift between pieces when one was
 * recorded with other settings. Doing it here makes one call one recording.
 *
 * Splitting is message read-aloud's, moved here so both use one. Joining is
 * byte-level: every piece comes from the same model, voice and format, so the
 * pieces' MPEG frames can follow one another. What cannot is per-file framing:
 * a leading ID3 tag, a trailing ID3v1 tag, and the Xing, Info or VBRI frame an
 * encoder writes first to say how long *its* file is. Left in, a player would
 * read the first piece's length as the whole recording's.
 */

/** Azure's speech endpoint rejects an individual input above 4,096 characters. */
export const AZURE_SPEECH_INPUT_CHARACTERS = 4_096;

/**
 * Text cut at the best boundary within each request: a paragraph, then a
 * sentence, a line, a word. Shared with message read-aloud
 * (`message-speech-service.ts`), which streams the same pieces as PCM.
 */
export function splitSpeechText(
  text: string,
  maximumCharacters = AZURE_SPEECH_INPUT_CHARACTERS,
): string[] {
  if (maximumCharacters < 1) throw new RangeError("maximumCharacters must be positive");
  const characters = [...text];
  if (characters.length <= maximumCharacters) return [text];

  const chunks: string[] = [];
  let offset = 0;
  while (offset < characters.length) {
    const remaining = characters.length - offset;
    if (remaining <= maximumCharacters) {
      chunks.push(characters.slice(offset).join("").trim());
      break;
    }
    const window = characters.slice(offset, offset + maximumCharacters).join("");
    const boundary = bestBoundary(window);
    chunks.push(characters.slice(offset, offset + boundary).join("").trim());
    offset += boundary;
    while (/\s/u.test(characters[offset] ?? "")) offset += 1;
  }
  return chunks.filter(Boolean);
}

function bestBoundary(window: string): number {
  const candidates = [
    window.lastIndexOf("\n\n"),
    Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? ")),
    window.lastIndexOf("\n"),
    window.lastIndexOf(" "),
  ];
  // Do not produce a tiny leading chunk merely because it contains an early
  // boundary; fill at least half of Azure's available request before splitting.
  const minimum = Math.floor([...window].length / 2);
  for (const candidate of candidates) {
    if (candidate >= minimum) return [...window.slice(0, candidate + 1)].length;
  }
  return [...window].length;
}

/**
 * The pieces as one MP3. One piece is returned unchanged; with several, each
 * loses its ID3 tags and its length-header frame, so the result is the pieces'
 * audio frames in order.
 */
export function joinMp3Pieces(pieces: readonly Uint8Array[]): Uint8Array {
  if (pieces.length === 1) return pieces[0]!;
  const frames = pieces.map(audioFrames);
  const out = new Uint8Array(frames.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of frames) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function audioFrames(bytes: Uint8Array): Uint8Array {
  let start = 0;
  // ID3v2: "ID3", version, flags, then a 28-bit syncsafe size; a footer adds 10.
  while (bytes.length - start >= 10 && bytes[start] === 0x49 && bytes[start + 1] === 0x44 && bytes[start + 2] === 0x33) {
    const size = ((bytes[start + 6]! & 0x7f) << 21) | ((bytes[start + 7]! & 0x7f) << 14)
      | ((bytes[start + 8]! & 0x7f) << 7) | (bytes[start + 9]! & 0x7f);
    start += 10 + size + ((bytes[start + 5]! & 0x10) !== 0 ? 10 : 0);
  }
  let end = bytes.length;
  // ID3v1: the last 128 bytes, starting "TAG".
  if (end - start >= 128 && bytes[end - 128] === 0x54 && bytes[end - 127] === 0x41 && bytes[end - 126] === 0x47) end -= 128;
  const length = frameLength(bytes, start);
  if (length !== null && start + length <= end && namesLength(bytes.subarray(start, start + length))) start += length;
  return bytes.subarray(start, end);
}

const BITRATES_KBPS = {
  mpeg1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  mpeg2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
} as const;
const SAMPLE_RATES = { 3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8_000] } as const;

/** The byte length of the MPEG Layer III frame at `offset`, or null when none starts there. */
function frameLength(bytes: Uint8Array, offset: number): number | null {
  if (bytes.length - offset < 4 || bytes[offset] !== 0xff || (bytes[offset + 1]! & 0xe0) !== 0xe0) return null;
  const version = (bytes[offset + 1]! >> 3) & 0x03;
  const layer = (bytes[offset + 1]! >> 1) & 0x03;
  if (version === 1 || layer !== 1) return null;
  const bitrate = (version === 3 ? BITRATES_KBPS.mpeg1 : BITRATES_KBPS.mpeg2)[(bytes[offset + 2]! >> 4) & 0x0f];
  const sampleRate = SAMPLE_RATES[version as 0 | 2 | 3][(bytes[offset + 2]! >> 2) & 0x03];
  if (!bitrate || !sampleRate) return null;
  const padding = (bytes[offset + 2]! >> 1) & 0x01;
  return Math.floor(((version === 3 ? 144 : 72) * bitrate * 1_000) / sampleRate) + padding;
}

/** Whether a frame is an encoder's length header (Xing, Info or VBRI) rather than audio. */
function namesLength(frame: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(frame.subarray(0, Math.min(frame.length, 64)));
  return head.includes("Xing") || head.includes("Info") || head.includes("VBRI");
}
