import type { HarnessSkill } from "../../types";

/**
 * How to make one podcast episode: a script written for the ear, an
 * AI-voiced recording of it, the episode's artwork, and the record a feed
 * needs.
 *
 * It covers only the episode. Where the episode goes (a feed, its database,
 * its page, who can open it) is `publishing-a-feed`'s, and this skill ends by
 * handing over the record that skill stores.
 *
 * Most of its weight is the script. The speech model reads every character it
 * is given: a heading's hash, a bullet's asterisk, a bare URL and a table are
 * all spoken or stumbled over, so text that reads well on a screen sounds
 * broken. The cleanup rules are what turns a newsletter into something a
 * listener can follow.
 *
 * `ownerPlugin` is the Terminal plugin: the recording is joined and encoded,
 * and the artwork resized, with ffmpeg in a sandbox. The speech and image
 * generators are a second plugin the body names for the model to load.
 */

const CREATING_A_PODCAST_EPISODE_BODY = `Make one episode: a script written for the ear, an AI-voiced recording of
it, its artwork, and the record a feed stores. Load
\`rally_multimodal_generation\` for speech and images, and Terminal for
ffmpeg and \`publish_resource\`; loading this skill activates neither. Where
the episode is published is \`publishing-a-feed\`'s, not this skill's.

1. **Start from the whole source.** Read the full text, never a preview or
   snippet. Keep what identifies it: its title, its date, its link, and a
   stable id from where it came from (a message id, a post's URL). That id
   is the episode's GUID in the feed.

2. **Write the script for the ear.** The speech model reads every character
   it gets. Turn the source into plain spoken sentences, and keep every
   point it makes: this is the source read aloud, not a summary, unless the
   person asked for one.
   - **Remove formatting marks.** Drop \`#\`, \`*\`, \`_\`, \`>\`, backticks and
     emphasis markers. A heading becomes a spoken transition: "Next, the
     funding round."
   - **Turn lists into sentences.** "Three things changed. First, … Second,
     … And third, …". Never read a bullet as a fragment.
   - **Turn tables into sentences**, one row at a time, naming what each
     number is.
   - **Drop URLs.** Say what a link points to ("their announcement post"),
     and keep the URLs for the show notes.
   - **Write numbers, units and symbols as they are said.** "$5M" is "five
     million dollars", "Q3" is "the third quarter", "3x" is "three times",
     "11/14" is "November fourteenth", "~40%" is "about forty percent".
   - **Expand abbreviations a listener cannot see.** "e.g." is "for
     example", "vs." is "versus". Spell out an acronym said as letters the
     first time ("A P I, the interface …") unless it is said as a word.
   - **Remove what only makes sense on a screen**: emoji, footnote markers,
     image captions, "click here", "see below", "view in browser",
     unsubscribe and footer text, tracking notes and repeated navigation.
   - **Describe code; do not read it.** Say what it does in a sentence.
   - **Keep sentences short.** Break a long sentence with several clauses
     into two or three; a listener cannot glance back.
   - **Add an opening and a close.** Open with the show's name, the
     episode's title and date, and one sentence saying the episode is read
     by an AI voice. Close with one sentence pointing to the show notes.

3. **Split the script at paragraph, then sentence, boundaries** into pieces
   under the per-call limit the speech generator's schema states. Never cut
   a sentence in two, and never drop text to fit.

4. **Keep one voice and one reading style.** Choose a voice and write short
   \`instructions\` for how to read: for example, "A warm, clear narrator
   reading a newsletter aloud. Moderate pace. Brief pauses between
   sections. Neutral, not dramatic." Use the same voice and the same
   instructions for every piece and every episode of the show, and store
   them with the show (\`publishing-a-feed\`), or the episode changes voice
   halfway through. The instructions are about delivery only; never put
   script text in them.

5. **Record every piece, and keep a ledger.** Generate one recording per
   piece, in order. For each, keep its index, a hash of its text and the
   resource id it returned, so a retry reuses the pieces it already has
   and records only the missing ones.

6. **Join and finish the recording in Terminal.** Import every piece, list
   them in order in a file, and join them in one ffmpeg command that also
   evens out the loudness and encodes speech at a small size:

   \`\`\`
   printf "file '%s'\\n" part-*.mp3 > parts.txt
   ffmpeg -y -f concat -safe 0 -i parts.txt \\
     -af loudnorm=I=-16:TP=-1.5:LRA=11 -ac 1 -ar 44100 \\
     -codec:a libmp3lame -b:a 64k \\
     -metadata title="Episode title" -metadata artist="Show name" \\
     episode.mp3
   ffprobe -v error -show_entries format=duration -of csv=p=0 episode.mp3
   \`\`\`

   Name the pieces with zero-padded numbers (\`part-001.mp3\`) so they sort
   in order. Mono at 64 kbps is plenty for one voice. Loudness at -16 LUFS
   is the common podcast level, so episodes play at the same volume.

7. **Check the length against the script.** Speech runs at about 150 words
   a minute. If the recording is much shorter than the script's word count
   suggests, a piece failed or was cut off: find it in the ledger and record
   it again before going on.

8. **Make the episode's artwork.** Generate one square image about this
   episode's subject. Ask for an opaque, full-bleed scene with **no text and
   no logos**: Apple shows episode art beside the show's own cover, and text
   in generated images is often misspelled. Check it with \`view_image\`.
   Then convert it in Terminal to Apple's size, with no transparency:

   \`\`\`
   ffmpeg -y -i art.png -vf "scale=3000:3000:flags=lanczos,format=rgb24" -q:v 3 art.jpg
   \`\`\`

9. **Publish the recording and the artwork as files.** Use file names of
   only letters, digits, hyphens and dots, dated so they never collide:
   \`2026-11-14-no-ai-slop.mp3\` and \`2026-11-14-no-ai-slop.jpg\`. Publish
   each with \`publish_resource\` into the feed's Canvas, and keep each
   result's \`url\` and \`sizeBytes\`. If a result has no \`url\`, the file did
   not land in a Canvas, and no podcast app can reach it.

10. **Write the show notes**: two or three sentences on what the episode
    covers, a link to the source, and one sentence saying the audio is an AI
    voice. Use simple HTML: paragraphs, links and lists.

11. **Hand over the episode record.** The feed stores one row per episode
    (\`publishing-a-feed\`, \`reference/apple-podcasts.md\`): the GUID from
    step 1, the title, the show notes, the publication date, the audio's
    \`url\` and \`sizeBytes\`, its length in whole seconds, the artwork's
    \`url\`, and the next episode number. Write that row, or give it to
    whoever writes the feed. Report what you made from the results you
    have: never say an episode is in the feed until its row write
    succeeded.

## Anti-patterns

- **Sending the source text as it is.** The voice reads "hash hash Funding"
  and every bullet's asterisk. Do instead: write the script (step 2).
- **Summarizing to save time.** The person asked for the issue, not a
  digest. Do instead: keep every point, and say if any part could not be
  read.
- **A new voice or style per piece.** The episode changes speaker
  mid-sentence. Do instead: one voice and one set of instructions for the
  whole show.
- **Text in the episode art.** Generated lettering is often wrong, and
  Apple asks for none. Do instead: a scene with no text.
- **Reporting a finished episode on the recording alone.** Check its
  length (step 7) and confirm its row was written.
`;

export const CREATING_A_PODCAST_EPISODE_SKILL: HarnessSkill = {
  name: "creating-a-podcast-episode",
  description:
    "How to make one podcast episode from a text source: rewrite it as a script for the ear, record it with an AI voice in pieces, join and level it, make its artwork, and hand the feed its record.",
  whenToUse:
    "When a newsletter, article, report or other text should become an audio episode, whether one-off or for a podcast feed.",
  body: CREATING_A_PODCAST_EPISODE_BODY,
  ownerPlugin: "rally:terminal",
};
