import type { HarnessSkill } from "../index";

/**
 * How to publish a feed an app subscribes to: a podcast's RSS feed, or a
 * calendar's iCalendar feed.
 *
 * A feed is a site route that an app with no Rally sign-in reads on its own
 * schedule, so everything here follows from two facts the site skill does not
 * cover: Rally admits that app only when the Canvas's artifacts are public, and
 * the site's own viewer checks must not stand in front of the feed. It
 * composes `building-live-sites` for the handler and storage class rather than
 * repeating them.
 *
 * `ownerPlugin` is the Terminal plugin, for the same reason as the site skill:
 * the procedure publishes a site and its audio from a sandbox.
 */

const PUBLISHING_A_FEED_BODY = `A feed is a route on a Rally site that an app reads by itself: a podcast
app polls an RSS feed, a calendar app an iCalendar feed. Load
\`building-live-sites\` for the handler and storage class, and Terminal for
\`publish_resource\`; loading this skill activates neither.

1. **Settle who the link reaches before you build.** A podcast or calendar
   app never signs in to Rally, so Rally serves it only when the Canvas's
   artifact audience is **public: anyone with the link**. That audience
   covers every site and file this Canvas has published, not just the feed.
   - If the Canvas holds nothing the person would mind anyone with a link
     seeing, tell them so in one sentence, and when they agree, set the
     Canvas's artifact audience to public as a change they asked for.
   - If it holds private material (their own email, internal plans, other
     people's details), say that a public feed would expose it too, and
     suggest they start a new Canvas just for the feed. Do not make the
     audience public until they choose.
   - A Sidekick run cannot change the audience. If the feed is not public
     yet, say who can open it now and that the Canvas's creator or an
     Organization admin can change it in the Canvas's Share screen.

2. **Keep one row per entry in the site's database.** Build a stateful site
   (\`building-live-sites\`, Stateful sites) with one table of entries, and
   write a row per new episode or event with \`write_artifact_data\`, never by
   republishing. For a podcast:

   | Column | Holds |
   | --- | --- |
   | \`guid\` | A stable id from the source, such as the email's message id. A retry updates the same row; a new id makes a duplicate episode in every subscriber's app. |
   | \`title\`, \`description\` | Plain text. |
   | \`published_at\` | ISO 8601 UTC. Convert to RFC 822 when rendering \`pubDate\`. |
   | \`audio_url\` | The audio file's \`url\` from \`publish_resource\`. |
   | \`audio_bytes\` | The file's \`sizeBytes\` from the same result. |
   | \`duration_seconds\` | From \`ffprobe\`. |

   For a calendar, keep \`uid\`, \`summary\`, \`starts_at\`, \`ends_at\`,
   \`location\` and \`updated_at\` instead.

3. **Serve the feed before any viewer check.** In the storage class's
   \`fetch\`, answer the feed path first and read no viewer header on it: a
   viewer check returns 401 to every app, and the feed never updates. Keep
   whatever checks the site's other routes already have.

   \`\`\`js
   if (url.pathname === "/feed.xml") {
     const rows = this.ctx.storage.sql
       .exec("SELECT * FROM episodes ORDER BY published_at DESC")
       .toArray();
     return new Response(renderRss(rows, url.origin), {
       headers: { "content-type": "application/rss+xml; charset=utf-8" },
     });
   }
   \`\`\`

   Serve a calendar at \`/calendar.ics\` as \`text/calendar; charset=utf-8\`.

4. **Render the feed exactly.** For RSS 2.0, a \`<channel>\` with
   \`title\`, \`link\` (the site's URL), \`description\` and \`language\`; then
   one \`<item>\` per row, newest first, each with \`title\`, \`description\`,
   \`pubDate\`, \`<guid isPermaLink="false">\` and
   \`<enclosure url="…" length="…" type="audio/mpeg"/>\`. Add the
   \`xmlns:itunes\` namespace with \`itunes:duration\` (seconds) and
   \`itunes:explicit\` (\`false\`); podcast apps read them. Escape \`&\`, \`<\`,
   \`>\` and quotes in every value, or one title with an ampersand breaks the
   whole feed. For iCalendar, use CRLF line endings, one \`VEVENT\` per row
   with \`UID\`, \`DTSTAMP\`, \`DTSTART\` and \`SUMMARY\`, and fold lines longer
   than 75 octets.

5. **Make each episode's audio a file of its own.** The speech generator
   (load \`rally_multimodal_generation\`) reads a limited amount of text per
   call, and its schema states the limit.
   - Split the text at paragraph, then sentence, boundaries into pieces
     under that limit. Never summarize or drop text to fit.
   - Generate one MP3 per piece and keep each piece's index, text hash and
     resource id, so a retry reuses the pieces it already has.
   - Import the pieces into Terminal and join them in order with ffmpeg's
     concat demuxer, re-encoding to mono MP3 at 64 kbps: plenty for speech,
     and about half the size of the generator's output.
   - Publish the joined file with \`publish_resource\`, and read its length
     with \`ffprobe\`. If the publish is refused as too large, lower the
     bitrate and publish again.

   The result carries the file's \`url\` when it landed in a Canvas. If it
   does not, the file stayed in this conversation and no app can reach it:
   publish from the Canvas's Chat, or from a run that writes that Canvas.

6. **Check it as an app would.** Request the feed URL from Terminal with no
   cookies and confirm a 200 with the content type above, then a \`HEAD\` on
   one enclosure URL and confirm a 200. A new file can take a few seconds to
   serve after it is published. If Terminal cannot reach the URL, say you
   could not check it rather than reporting that it works.

7. **Give the person the feed URL and how to add it**: in Apple Podcasts,
   Library, then Follow a Show by URL; in Overcast or Pocket Casts, add by
   URL. For a calendar, the app's Subscribe to Calendar or From URL option.
   Say that anyone with the link can listen or see the events, and that a
   new entry appears at the app's next refresh, not at once.

## What Rally does not do yet

Say these plainly when they matter; do not build around them.

- **No seeking within an episode.** Rally sends the whole file and does not
  answer byte-range requests, so some apps cannot skip ahead until the
  episode has downloaded. Apple's podcast directory requires byte ranges, so
  treat the feed as a private link to subscribe to, never as a show to
  submit to a directory.
- **No caching.** Every refresh by every app reaches the site.

## Anti-patterns

- **A viewer check on the feed or audio.** Every app gets 401. Answer the
  feed first, with no identity.
- **Audio bundled into the site's own files.** A site publish has a size
  cap that one long episode can fill. Publish each episode as its own file
  and link its \`url\`.
- **A new \`guid\` on every retry.** Subscribers get the episode twice.
  Derive it from the source.
- **Reporting the feed works without fetching it.** Check it as an app
  would (step 6), or say you could not.
`;

export const PUBLISHING_A_FEED_SKILL: HarnessSkill = {
  name: "publishing-a-feed",
  description:
    "How to publish a podcast RSS feed or a calendar feed from a Canvas that an app subscribes to without a Rally sign-in: who the link reaches, one row per entry, the feed route, long episode audio, and checking it as an app would.",
  whenToUse:
    "When someone wants a link to add to a podcast app, calendar app or feed reader, or episodes or events that keep arriving by themselves.",
  body: PUBLISHING_A_FEED_BODY,
  ownerPlugin: "rally:terminal",
};
