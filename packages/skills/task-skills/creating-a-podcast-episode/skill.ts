import type { HarnessSkill } from "../../types";

/**
 * How to make one podcast episode: a script written for the ear, an
 * AI-voiced recording of it, its chapters, the episode's artwork, and the
 * record a feed needs.
 *
 * Chapters go two places because players read them from two: ID3 chapter
 * frames inside the MP3, and the rows the feed serves as a Podcasting 2.0
 * chapters file (`publishing-a-feed`, `reference/apple-podcasts.md`).
 *
 * It covers only the episode, up to its files in the feed site's directory.
 * Publishing that site, its database, its page and who can open it are
 * `publishing-a-feed`'s, and this skill ends by handing over the record that
 * skill stores.
 *
 * Most of its weight is the script. The speech model reads every character it
 * is given: a heading's hash, a bullet's asterisk, a bare URL and a table are
 * all spoken or stumbled over, so text that reads well on a screen sounds
 * broken. The cleanup rules are what turns a newsletter into something a
 * listener can follow.
 *
 * `generate_audio` records a section longer than one request in pieces, so a section is one call; the
 * sections stay separate calls because the chapters are timed from them.
 *
 * `ownerPlugin` is the Terminal plugin: the recording is joined and encoded,
 * and the artwork resized, with ffmpeg in a sandbox. The speech and image
 * generators are a second plugin the body names for the model to load.
 */

const CREATING_A_PODCAST_EPISODE_BODY = `Make one episode: a script written for the ear, an AI-voiced recording of
it, its chapters, its artwork, and the record a feed stores. Load
\`rally_multimodal_generation\` for speech and images, and Terminal for
ffmpeg and the files; loading this skill activates neither. The episode's
files end up inside the feed's site; publishing that site is
\`publishing-a-feed\`'s, not this skill's.

Before recording, check that the sandbox has ffmpeg: run
\`ffmpeg -version && ffprobe -version\`. Rally's sandbox ships both, but one
created before they were added may not. If either is missing, install it with
\`sudo -n apt-get install -y --no-install-recommends ffmpeg\`; if that fails
too, stop and say the sandbox has no ffmpeg, before spending any speech
calls.

Name the episode once, at the start, with only letters, digits, hyphens and
dots and dated so it never collides with another, such as
\`2026-11-14-no-ai-slop\`. Its recording and its art are published under that
name; a fixed name would make every episode replace the last.

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
   - **Mark the sections as you write.** Each part of the source a listener
     would want to jump to (a story, a segment, a topic) is a section with
     a title of a few plain words: "Opening", "The funding round",
     "Reader questions". These become the episode's chapters. The opening
     is the first section.

3. **Keep one voice and one reading style.** Choose a voice and write short
   \`instructions\` for how to read: for example, "A warm, clear narrator
   reading a newsletter aloud. Moderate pace. Brief pauses between
   sections. Neutral, not dramatic." Use the same voice and the same
   instructions for every section and every episode of the show, and store
   them with the show (\`publishing-a-feed\`), or the episode changes voice
   halfway through. The instructions are about delivery only; never put
   script text in them.

4. **Record one section per call, and keep a ledger.** Call
   \`generate_audio\` once per section, in order, with that section's whole
   text, whatever its length: Rally records long text in pieces and joins
   them. For each section, keep its index, a hash of its text and the
   resource id it returned, so a retry reuses the sections it already has
   and records only the missing ones. One call per section, not one for the
   whole script, is what lets each chapter start exactly where a section
   does.

5. **Join and finish the recording in Terminal.** Import every section,
   list them in order in a file, and join them in one ffmpeg command that
   also evens out the loudness and encodes speech at a small size:

   \`\`\`
   printf "file '%s'\\n" section-*.mp3 > sections.txt
   ffmpeg -y -f concat -safe 0 -i sections.txt \\
     -af loudnorm=I=-16:TP=-1.5:LRA=11 -ac 1 -ar 44100 \\
     -codec:a libmp3lame -b:a 64k \\
     -metadata title="Episode title" -metadata artist="Show name" \\
     episode.mp3
   ffprobe -v error -show_entries format=duration -of csv=p=0 episode.mp3
   \`\`\`

   Name the sections with zero-padded numbers (\`section-01.mp3\`) so they
   sort in order. Mono at 64 kbps is plenty for one voice and keeps an
   episode of about 50 minutes under the size one publish accepts; for a
   longer one use \`-b:a 48k\`. Loudness at -16 LUFS is the common podcast
   level, so episodes play at the same volume.

6. **Check the length against the script.** Speech runs at about 150 words
   a minute. If the recording is much shorter than the script's word count
   suggests, a section failed or was cut off: find it in the ledger and
   record it again before going on.

7. **Add the chapters.** Give an episode with two or more sections one
   chapter per section; an episode with one section gets none.
   - **Time each chapter from the sections.** Read each section's length
     with \`ffprobe\`. A section's start is the sum of the lengths of the
     sections before it. Its end is the next section's start, and the last
     one ends at the episode's length.
   - **Write them into the MP3**, in a second ffmpeg pass that copies the
     audio unchanged. Put the episode's own tags in the same file, since
     this pass replaces them:

     \`\`\`
     ;FFMETADATA1
     title=Episode title
     artist=Show name
     [CHAPTER]
     TIMEBASE=1/1000
     START=0
     END=41250
     title=Opening
     [CHAPTER]
     TIMEBASE=1/1000
     START=41250
     END=318900
     title=The funding round
     \`\`\`

     \`\`\`
     ffmpeg -y -i episode.mp3 -i chapters.txt -map 0:a -map_metadata 1 -map_chapters 1 \\
       -codec copy -id3v2_version 3 -write_id3v1 0 2026-11-14-no-ai-slop.mp3
     ffprobe -v error -show_chapters -of compact 2026-11-14-no-ai-slop.mp3
     \`\`\`

     Write the episode's own name, not this example's. Confirm \`ffprobe\`
     lists every chapter with its title and start. An episode with no
     chapters is renamed from \`episode.mp3\` to its own name instead.
   - **Keep the list** of each chapter's start in seconds and its title,
     for the feed (step 11).

8. **Make the episode's artwork.** Generate one image at size \`1024x1024\`
   about this episode's subject. Ask for an opaque, full-bleed scene with **no text and
   no logos**: Apple shows episode art beside the show's own cover, and text
   in generated images is often misspelled. Check it with \`view_image\`.
   Then convert it in Terminal to Apple's size, with no transparency:

   \`\`\`
   ffmpeg -y -i art.png -vf "scale=3000:3000:flags=lanczos,format=rgb24" -q:v 3 2026-11-14-no-ai-slop.jpg
   \`\`\`

9. **Put the recording and the artwork in the feed site's directory**, after
   recovering the site there (\`publishing-a-feed\`, step 7.1; never before):
   \`episodes/2026-11-14-no-ai-slop.mp3\` and
   \`episodes/2026-11-14-no-ai-slop.jpg\`. They are never published on their
   own, since the site's page plays only its own files. Read each file's size
   in bytes with \`stat -c %s\` for the record.

10. **Write the show notes**: two or three sentences on what the episode
    covers, a link to the source, and one sentence saying the audio is an AI
    voice. Use simple HTML: paragraphs, links and lists.

11. **Hand over the episode record.** The feed stores one row per episode
    (\`publishing-a-feed\`, \`reference/apple-podcasts.md\`): the GUID from
    step 1, the title, the show notes, the publication date, the audio's
    path in the site and its size in bytes, its length in whole seconds,
    the artwork's path, the next episode number, and one chapter row per
    chapter (its start in seconds and its title). Write that row once the
    site with the new files is published, or give it to whoever does.
    Report what you made from the results you have: never say an episode is
    in the feed until its row write succeeded.

## Anti-patterns

- **Sending the source text as it is.** The voice reads "hash hash Funding"
  and every bullet's asterisk. Do instead: write the script (step 2).
- **Summarizing to save time.** The person asked for the issue, not a
  digest. Do instead: keep every point, and say if any part could not be
  read.
- **A new voice or style per section.** The episode changes speaker
  between chapters. Do instead: one voice and one set of instructions for
  the whole show.
- **Text in the episode art.** Generated lettering is often wrong, and
  Apple asks for none. Do instead: a scene with no text.
- **Chapters timed by guesswork.** A chapter that starts mid-sentence sends
  the listener to the wrong place. Do instead: record one section per call,
  and time it from the sections' measured lengths (step 7).
- **Splitting a section by hand to fit a request.** \`generate_audio\`
  records a long section in pieces itself. Do instead: send each section
  whole, and if one is refused for its size, split it at a natural break.
- **Reporting a finished episode on the recording alone.** Check its
  length (step 6) and confirm its row was written.
`;

export const CREATING_A_PODCAST_EPISODE_SKILL: HarnessSkill = {
  name: "creating-a-podcast-episode",
  description:
    "How to make one podcast episode from a text source: rewrite it as a script for the ear, record it with an AI voice one section at a time, join and level it, add chapters, make its artwork, put its files in the feed's site, and hand the feed its record.",
  whenToUse:
    "When a newsletter, article, report or other text should become an episode of a podcast.",
  body: CREATING_A_PODCAST_EPISODE_BODY,
  ownerPlugin: "rally:terminal",
};
