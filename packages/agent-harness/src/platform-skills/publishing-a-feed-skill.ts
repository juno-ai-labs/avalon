import type { HarnessSkill } from "../index";

/**
 * How to publish any feed an app subscribes to: a podcast, a calendar, a news
 * or updates feed.
 *
 * A feed is a site route that an app with no Rally sign-in reads on its own
 * schedule, so the procedure follows from two facts the site skill does not
 * cover: Rally admits that app only when the Canvas's artifacts are public, and
 * the site's own viewer checks must not stand in front of the feed. The body is
 * the same for every format; what differs per format (the elements, the
 * content type, media enclosures) is the reference resource, read once the
 * format is known. It composes `building-live-sites` for the handler and
 * storage class rather than repeating them.
 *
 * The audience follows the site skill's standing procedure: public by default,
 * set after publishing, then said back to the person with a question at the
 * end. The build never waits on that answer.
 *
 * `ownerPlugin` is the Terminal plugin, for the same reason as the site skill:
 * the procedure publishes a site, and any media, from a sandbox.
 */

const PUBLISHING_A_FEED_BODY = `A feed is a route on a Rally site that an app reads by itself on its own
schedule: a podcast app, a calendar app, a feed reader. Every feed ships
with a page people open. Load \`building-live-sites\` for the handler and
storage class, and Terminal for \`publish_resource\`; loading this skill
activates neither. Read \`reference/feed-formats.md\` once you know the
format.

1. **Choose the format from what the entries are.** Episodes with audio or
   video: a podcast feed (RSS 2.0 with enclosures). Events with a time:
   iCalendar. Posts, updates, releases or anything else read in order: RSS
   2.0. Use another format only when the person names it.

2. **Build one site that holds both the feed and its page.** Build a stateful
   site (\`building-live-sites\`, Stateful sites) with one table of entries.
   Even when only a feed is asked for, its home page is part of the job. The
   page shows:
   - a title and one or two sentences on what the feed carries and how often
     it updates;
   - the feed URL in a read-only field with a **Copy link** button beside it;
   - one line each on adding it in two or three common apps for its kind
     (the reference names them);
   - the newest entries, each with its title and date, and a link to its
     media file when it has one. Link with \`<a href>\`: the page cannot play
     a separately published file in an \`<audio>\` element
     (\`building-live-sites\`, Media, downloads and feeds).

3. **Keep one row per entry, keyed by the source.** Give each row a stable
   id from where the entry came from: a message id, an event id, a post's
   URL. A retry then updates the same row, and a new id makes a duplicate in
   every subscriber's app. Write rows with \`write_artifact_data\`, never by
   republishing, so a Sidekick can add entries later. The reference lists
   the columns each format needs.

4. **Serve the feed before any viewer check.** In the storage class's
   \`fetch\`, answer the feed path first, with the format's content type, and
   read no viewer header on it or on its media: a viewer check returns 401 to
   every app, and the feed never updates. Keep whatever checks the site's
   other routes already have.

   \`\`\`js
   if (url.pathname === "/feed.xml") {
     const rows = this.ctx.storage.sql
       .exec("SELECT * FROM entries ORDER BY published_at DESC")
       .toArray();
     return new Response(renderFeed(rows, url.origin), {
       headers: { "content-type": "application/rss+xml; charset=utf-8" },
     });
   }
   \`\`\`

5. **Render the format exactly.** Follow the reference for its required
   elements. Escape every value the format requires escaped: one title with
   an ampersand breaks the whole feed in every app.

6. **Publish each media file on its own.** When entries carry audio or
   video, publish each file with \`publish_resource\` and store its \`url\` and
   \`sizeBytes\` in the entry's row. Never bundle media into the site's own
   files: a site publish has a size cap one long episode can fill. If the
   result has no \`url\`, the file stayed in this conversation, where no app
   can reach it: publish from the Canvas's Chat, or from a run that writes
   that Canvas. For spoken audio longer than one call of the speech
   generator accepts, read \`reference/long-audio.md\`.

7. **Set the audience after publishing, as every site does.** An app never
   signs in, so the feed works only when the Canvas's artifacts are **public:
   anyone with the link**. Set the Canvas's artifact audience to public as
   your default choice, not as a change the person asked for. Do not stop
   the build to ask first.
   - If the result says someone already chose the audience and it is not
     public, leave it. Tell the person the feed cannot reach apps until it
     is, and ask whether to make it public.
   - A Sidekick run cannot set the audience. Say who can open it now, and
     that the Canvas's creator or an Organization admin can change it in the
     Canvas's Share screen.

8. **Check it as an app would.** From Terminal, request the feed URL with no
   cookies and confirm a 200 and the format's content type; for media, a
   \`HEAD\` on one file's URL, which should report \`accept-ranges: bytes\`
   and the file's length. A new file can take a few seconds to serve
   after it is published. If Terminal cannot reach the URL, say you could not
   check it rather than reporting that it works.

9. **End with the links, who can open them, and one question.** Give the
   page's URL and the feed URL. Say plainly that anyone with either link can
   open the page, the feed and everything else this Canvas has published,
   and name anything private the Canvas holds. Make your last question
   whether they understand that and want it to stay public. A new entry
   appears at each app's next refresh, not at once.

## What Rally does not do yet

Say this when it matters; do not build around it.

- **No caching.** Every refresh by every app reaches the site.

## Anti-patterns

- **A feed with no page.** The person has nothing to open and nowhere to
  copy the link from. Build the page with every feed.
- **Asking who may open it before building.** The default is public; build,
  then say who can open it and ask.
- **A viewer check on the feed or its media.** Every app gets 401. Answer
  the feed first, with no identity.
- **A new id on every retry.** Subscribers get the entry twice. Derive it
  from the source.
- **Reporting the feed works without fetching it.** Check it as an app
  would (step 8), or say you could not.
`;

const FEED_FORMATS = `# Feed formats

## RSS 2.0 (posts, updates, releases)

- Path \`/feed.xml\`, content type \`application/rss+xml; charset=utf-8\`.
- \`<rss version="2.0">\` holding one \`<channel>\` with \`title\`, \`link\` (the
  site's URL), \`description\` and \`language\`; then one \`<item>\` per row,
  newest first, each with \`title\`, \`link\`, \`description\`, \`pubDate\` and
  \`<guid isPermaLink="false">\`.
- Columns: \`entry_id\` (the stable source id), \`title\`, \`summary\`, \`link\`,
  \`published_at\` (ISO 8601 UTC).
- \`pubDate\` is RFC 822: \`Sat, 14 Nov 2026 17:02:39 GMT\`. Convert from
  \`published_at\` when rendering.
- Escape \`&\`, \`<\`, \`>\`, \`"\` and \`'\` in every value.
- Apps: any feed reader (Feedly, NetNewsWire, Inoreader) adds it by URL.

## Podcast (RSS 2.0 with enclosures)

- Everything in RSS 2.0, plus on \`<rss>\` the namespace
  \`xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"\`.
- On \`<channel>\`: \`itunes:author\`, \`itunes:explicit\` (\`false\`), and
  \`itunes:image href="…"\` when there is cover art.
- On each \`<item>\`: \`<enclosure url="…" length="…" type="audio/mpeg"/>\` and
  \`itunes:duration\` in seconds.
- Columns: the RSS ones, plus \`media_url\` and \`media_bytes\` (the file's
  \`url\` and \`sizeBytes\` from \`publish_resource\`) and \`duration_seconds\`
  (from \`ffprobe\`).
- Apps: Apple Podcasts (Library, then Follow a Show by URL), Overcast and
  Pocket Casts (add by URL).

## iCalendar (events)

- Path \`/calendar.ics\`, content type \`text/calendar; charset=utf-8\`.
- \`BEGIN:VCALENDAR\`, \`VERSION:2.0\`, \`PRODID:-//Rally//Feed//EN\`, then one
  \`VEVENT\` per row with \`UID\`, \`DTSTAMP\`, \`DTSTART\`, \`DTEND\` and
  \`SUMMARY\`, and \`LOCATION\` or \`DESCRIPTION\` when present.
- Columns: \`uid\` (the stable source id), \`summary\`, \`starts_at\`,
  \`ends_at\`, \`location\`, \`description\`, \`updated_at\`.
- Write times in UTC as \`20261114T170239Z\`, and an all-day event as
  \`DTSTART;VALUE=DATE:20261114\`.
- End every line with CRLF. Fold a line longer than 75 octets by breaking it
  and starting the next line with one space. Escape \`\\\`, \`;\`, \`,\` and
  newlines (as \`\\n\`) in text values.
- Apps: Google Calendar (Other calendars, then From URL), Apple Calendar
  (File, then New Calendar Subscription), Outlook (Add calendar, then
  Subscribe from web).
`;

const LONG_AUDIO = `# Long spoken audio

The speech generator (load \`rally_multimodal_generation\`) reads a limited
amount of text per call, and its schema states the limit.

1. Split the text at paragraph, then sentence, boundaries into pieces under
   that limit. Never summarize or drop text to make it fit.
2. Generate one MP3 per piece. Keep each piece's index, a hash of its text
   and its resource id, so a retry reuses the pieces it already has.
3. Import the pieces into Terminal and join them in order with ffmpeg's
   concat demuxer, re-encoding to mono MP3 at 64 kbps: plenty for speech,
   and about half the size of the generator's output.
4. Read the joined file's length with \`ffprobe\`, then publish it.
5. If the publish is refused as too large, lower the bitrate and publish
   again. Never split one episode into several entries to fit.
`;

export const PUBLISHING_A_FEED_SKILL: HarnessSkill = {
  name: "publishing-a-feed",
  description:
    "How to publish any feed an app subscribes to without a Rally sign-in (a podcast, calendar, or news and updates feed): its page with a copyable link, one row per entry, the feed route, media files, and checking it as an app would.",
  whenToUse:
    "When someone wants a link to add to a podcast app, calendar app or feed reader, or entries that keep arriving by themselves.",
  body: PUBLISHING_A_FEED_BODY,
  ownerPlugin: "rally:terminal",
  resources: [
    { path: "reference/feed-formats.md", body: FEED_FORMATS },
    { path: "reference/long-audio.md", body: LONG_AUDIO },
  ],
};
