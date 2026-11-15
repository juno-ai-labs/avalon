import type { HarnessSkill } from "../index";

/**
 * How to publish any feed an app subscribes to: a podcast, a calendar, a news
 * or updates feed.
 *
 * A feed is a site route that an app with no Rally sign-in reads on its own
 * schedule, so the procedure follows from two facts the site skill does not
 * cover: Rally admits that app only when the Canvas's artifacts are public, and
 * the site's own viewer checks must not stand in front of the feed. The feed is
 * data powered: one renderer, written and checked once, turns the site's rows
 * into the document on every request, and a new entry is a row write. An agent
 * that hand-writes the document for each entry gets it subtly wrong, and every
 * app that reads it fails at once.
 *
 * The body is the same for every format; what differs per format is the
 * reference resource, read once the format is known. Apple Podcasts is the
 * podcast player most listeners use, and its rules get a reference of their
 * own. Making an episode itself (the script, the audio, its artwork) is
 * `creating-a-podcast-episode`. It composes `building-live-sites` for the
 * handler and storage class rather than repeating them.
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
format, and for a podcast also \`reference/apple-podcasts.md\`.

1. **Choose the format from what the entries are.** Episodes with audio or
   video: a podcast feed (RSS 2.0 with Apple's tags). Events with a time:
   iCalendar. Posts, updates, releases or anything else read in order: RSS
   2.0. Use another format only when the person names it.

2. **Make the feed data powered.** The feed document is never written by
   hand, for the first entry or any later one. Build a stateful site
   (\`building-live-sites\`, Stateful sites) whose database holds everything
   the feed says:
   - a **show** table with one row: the title, description, author, artwork
     path, language, category and every other channel-level value;
   - an **entries** table with one row per episode, event or post;
   - for a podcast, a **chapters** table with one row per chapter of an
     episode, keyed by the episode's id and the chapter's start.

   The site's code renders the feed from those rows on every request, with
   one function per element and one escaping function every value passes
   through. Write that renderer once, check its output (step 8), and leave
   it alone. Adding an entry is one row write with \`write_artifact_data\`;
   changing the show's description is one update to its row. Never store
   rendered XML or calendar text in a row, and never republish the site to
   add an entry. The reference lists each format's columns. A podcast's
   chapters file is rendered the same way, from the chapters rows, at its
   own route (\`reference/apple-podcasts.md\`).

3. **Key every entry by its source.** Give each row a stable id from where
   the entry came from: a message id, an event id, a post's URL. A retry
   then updates the same row, and a new id makes a duplicate in every
   subscriber's app. Declare that id the primary key when you create the
   table. Seed the first rows after publishing, and leave later rows to the
   Sidekick or person that adds entries.

4. **Build one site that holds both the feed and its page.** Even when only a
   feed is asked for, its home page is part of the job, and it reads the
   same rows. The page shows:
   - the show's artwork, title, and one or two sentences on what the feed
     carries and how often it updates;
   - the feed URL in a read-only field with a **Copy link** button beside it;
   - one line each on adding it in two or three common apps for its kind
     (the reference names them);
   - the newest entries, each with its title and date, and a link to its
     media file when it has one. Link with \`<a href>\`: the page cannot play
     a separately published file in an \`<audio>\` element
     (\`building-live-sites\`, Media, downloads and feeds).

5. **Give the feed its artwork.** A podcast or news feed needs a cover:
   load \`rally_multimodal_generation\` and generate one square image that
   represents the show, following the artwork rules in the reference for
   its format. Check it with \`view_image\`, and generate again if any text
   in it is misspelled or unreadable. Convert it in Terminal to the size
   and format the reference names, save it in the site's directory (for
   example \`cover.jpg\`), and store its path in the show row. Keeping it in
   the site's directory lets the page show it and the feed name it.

6. **Serve the feed before any viewer check.** In the storage class's
   \`fetch\`, answer the feed path (and a podcast's chapters path) first,
   with the format's content type, and read no viewer header on it or on its
   media: a viewer check returns 401 to
   every app, and the feed never updates. Keep whatever checks the site's
   other routes already have.

   \`\`\`js
   if (url.pathname === "/feed.xml") {
     const show = this.ctx.storage.sql.exec("SELECT * FROM show").one();
     const entries = this.ctx.storage.sql
       .exec("SELECT * FROM entries ORDER BY published_at DESC")
       .toArray();
     return new Response(renderFeed(show, entries, url.origin), {
       headers: { "content-type": "application/rss+xml; charset=utf-8" },
     });
   }
   \`\`\`

7. **Publish each media file on its own.** When entries carry audio,
   video or per-entry artwork, publish each file with \`publish_resource\`
   and store its \`url\` and \`sizeBytes\` in the entry's row. Never bundle
   media into the site's own files: a site publish has a size cap one long
   episode can fill. If the result has no \`url\`, the file stayed in this
   conversation, where no app can reach it: publish from the Canvas's
   Chat, or from a run that writes that Canvas. To make a podcast episode
   (the script, the audio and its artwork), load
   \`creating-a-podcast-episode\`.

8. **Check it as an app would.** From Terminal, request the feed URL with no
   cookies and confirm a 200 and the format's content type. Parse the body
   with an XML or calendar parser (\`python3\` has both in its standard
   library) rather than reading it by eye, and confirm every entry row
   appears. For a podcast, also fetch one episode's chapters file and parse
   it as JSON. For media, send a \`HEAD\` to one file's URL, which should report
   \`accept-ranges: bytes\` and the file's length. A new file can take a few
   seconds to serve after it is published. If Terminal cannot reach the URL,
   say you could not check it rather than reporting that it works.

9. **Set the audience after publishing, as every site does.** An app never
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

10. **End with the links, who can open them, and one question.** Give the
    page's URL and the feed URL. Say plainly that anyone with either link
    can open the page, the feed and everything else this Canvas has
    published, and name anything private the Canvas holds. Make your last
    question whether they understand that and want it to stay public. A new
    entry appears at each app's next refresh, not at once. For a podcast
    they want listed in Apple Podcasts, say they submit the feed URL in
    Apple Podcasts Connect themselves, with their own Apple account.

## What Rally does not do yet

Say this when it matters; do not build around it.

- **No caching.** Every refresh by every app reaches the site.

## Anti-patterns

- **Hand-writing the feed.** XML typed out for each new episode breaks on
  the first unescaped ampersand or missing tag. Do instead: render from the
  rows, and add an entry as a row.
- **A feed with no page.** The person has nothing to open and nowhere to
  copy the link from. Build the page with every feed.
- **Asking who may open it before building.** The default is public; build,
  then say who can open it and ask.
- **A viewer check on the feed or its media.** Every app gets 401. Answer
  the feed first, with no identity.
- **A new id on every retry.** Subscribers get the entry twice. Derive it
  from the source.
- **Reporting the feed works without fetching it.** Parse it as an app
  would (step 8), or say you could not.
`;

const FEED_FORMATS = `# Feed formats

## RSS 2.0 (posts, updates, releases)

- Path \`/feed.xml\`, content type \`application/rss+xml; charset=utf-8\`.
- Start with \`<?xml version="1.0" encoding="UTF-8"?>\`, then
  \`<rss version="2.0">\` holding one \`<channel>\` with \`title\`, \`link\` (the
  site's URL), \`description\`, \`language\` and \`<image>\` (\`url\`, \`title\`,
  \`link\`) for the cover; then one \`<item>\` per row, newest first, each with
  \`title\`, \`link\`, \`description\`, \`pubDate\` and
  \`<guid isPermaLink="false">\`.
- Show row: \`title\`, \`description\`, \`language\` (such as \`en-us\`),
  \`cover_path\`.
- Entry columns: \`entry_id\` (the stable source id, primary key), \`title\`,
  \`summary\`, \`link\`, \`published_at\` (ISO 8601 UTC).
- \`pubDate\` is RFC 2822 with a zone offset: \`Sat, 14 Nov 2026 17:02:39 +0000\`.
  Convert from \`published_at\` when rendering.
- Escape \`&\` as \`&amp;\`, \`<\` as \`&lt;\`, \`>\` as \`&gt;\`, \`"\` as
  \`&quot;\` and \`'\` as \`&apos;\` in every value.
- Cover: a square image of the show's name or subject; 1400 pixels or
  larger is plenty.
- Apps: any feed reader (Feedly, NetNewsWire, Inoreader) adds it by URL.

## Podcast

Read \`reference/apple-podcasts.md\`: a podcast is RSS 2.0 written to Apple's
rules, which every other podcast app also reads.

## iCalendar (events)

- Path \`/calendar.ics\`, content type \`text/calendar; charset=utf-8\`.
- \`BEGIN:VCALENDAR\`, \`VERSION:2.0\`, \`PRODID:-//Rally//Feed//EN\`,
  \`X-WR-CALNAME\` from the show row's title, then one \`VEVENT\` per row with
  \`UID\`, \`DTSTAMP\`, \`DTSTART\`, \`DTEND\` and \`SUMMARY\`, and \`LOCATION\` or
  \`DESCRIPTION\` when present.
- Entry columns: \`uid\` (the stable source id, primary key), \`summary\`,
  \`starts_at\`, \`ends_at\`, \`location\`, \`description\`, \`updated_at\`.
- Write times in UTC as \`20261114T170239Z\`, and an all-day event as
  \`DTSTART;VALUE=DATE:20261114\`.
- End every line with CRLF. Fold a line longer than 75 octets by breaking it
  and starting the next line with one space. Escape \`\\\`, \`;\`, \`,\` and
  newlines (as \`\\n\`) in text values.
- A calendar has no artwork.
- Apps: Google Calendar (Other calendars, then From URL), Apple Calendar
  (File, then New Calendar Subscription), Outlook (Add calendar, then
  Subscribe from web).
`;

const APPLE_PODCASTS = `# A podcast feed for Apple Podcasts

Apple Podcasts is the player most listeners use, and other podcast apps
read the same tags, so write every podcast feed to these rules.

## The document

- Path \`/feed.xml\`, content type \`application/rss+xml; charset=utf-8\`.
- Start with \`<?xml version="1.0" encoding="UTF-8"?>\`, then:

  \`\`\`xml
  <rss version="2.0"
       xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
       xmlns:content="http://purl.org/rss/1.0/modules/content/"
       xmlns:podcast="https://podcastindex.org/namespace/1.0">
  \`\`\`

- Entities: use \`&amp;\`, \`&lt;\`, \`&gt;\`, \`&apos;\` and \`&quot;\`. Apple
  asks for \`&apos;\` and \`&quot;\`, never \`&rsquo;\`, \`&lsquo;\`, \`&ldquo;\`
  or \`&rdquo;\`; write any other character directly as UTF-8.
- URLs and file names use only \`a-z\`, \`A-Z\`, \`0-9\`, hyphens and dots:
  Apple asks for ASCII.

## The show row and \`<channel>\`

| Column | Element |
| --- | --- |
| \`title\` | \`<title>\` and \`<itunes:title>\`. |
| \`description\` | \`<description>\` and \`<itunes:summary>\`: what the show is, who it is for, how often it comes out, in plain sentences. |
| \`author\` | \`<itunes:author>\`: the person or organization behind the show. |
| \`owner_name\`, \`owner_email\` | \`<itunes:owner>\` holding \`<itunes:name>\` and \`<itunes:email>\`. Apple uses the email to confirm who owns the show when it is submitted, and the feed shows it to anyone. Use only an address the person gives for this, and leave both out until they do. |
| \`link\` | \`<link>\`: the site's URL. |
| \`language\` | \`<language>\`, such as \`en-us\`. |
| \`category\`, \`subcategory\` | \`<itunes:category text="News"><itunes:category text="Tech News"/></itunes:category>\`, from Apple's list below, exactly as written there. Self-close it when there is no subcategory. |
| \`explicit\` | \`<itunes:explicit>true</itunes:explicit>\` or \`false\`. |
| \`show_type\` | \`<itunes:type>\`: \`episodic\` when episodes stand alone, newest first; \`serial\` when they are meant in order. |
| \`cover_path\` | \`<itunes:image href="…"/>\` and \`<image>\`, with the absolute URL of the cover in the site's directory. |
| \`copyright\` | \`<copyright>\`, such as \`&#xA9; 2026\` followed by the author. |
| \`voice\`, \`voice_instructions\` | Not rendered. The voice and reading style every episode uses (\`creating-a-podcast-episode\`). |

## Each entry row and its \`<item>\`

| Column | Element |
| --- | --- |
| \`guid\` | \`<guid isPermaLink="false">\`: the stable source id, primary key. Apple requires a GUID that never changes. |
| \`title\` | \`<title>\` and \`<itunes:title>\`: the episode's own title, without the show's name or an episode number. |
| \`description_html\` | \`<description>\` and \`<content:encoded>\`, each wrapped in \`<![CDATA[…]]>\`: show notes with the source link. Keep to \`<p>\`, \`<a>\`, \`<ul>\`, \`<ol>\` and \`<li>\`. |
| \`published_at\` | \`<pubDate>\`, RFC 2822 with a zone offset: \`Sat, 14 Nov 2026 17:02:39 +0000\`. |
| \`audio_url\`, \`audio_bytes\` | \`<enclosure url="…" length="…" type="audio/mpeg"/>\`. Apple requires all three, and ignores a duplicate enclosure URL. |
| \`duration_seconds\` | \`<itunes:duration>\` in whole seconds. |
| \`image_url\` | \`<itunes:image href="…"/>\`: the episode's art. Leave it out when there is none, and Apple shows the cover. |
| \`episode_number\` | \`<itunes:episode>\`, counting from 1. Give each new row the next number. |
| \`season_number\` | \`<itunes:season>\`, only for a show that has seasons. |
| \`episode_type\` | \`<itunes:episodeType>\`: \`full\`, \`trailer\` or \`bonus\`. |
| \`explicit\` | \`<itunes:explicit>\` for this episode. |

Each entry with chapters also gets
\`<podcast:chapters url="…/chapters/<guid>.json" type="application/json+chapters"/>\`,
with the absolute URL of its chapters file.

## Chapters

Players read chapters from two places, and the feed supplies both: the ID3
chapter frames inside the MP3 (\`creating-a-podcast-episode\` writes them),
and a chapters file the feed links to, which Apple Podcasts reads from the
feed on iOS 26.2 and later. An episode with its own chapters also stops
Apple generating chapters of its own.

- **Rows:** a \`chapters\` table with \`guid\` (the episode's), \`start_seconds\`
  and \`title\`, keyed by \`guid\` and \`start_seconds\`. The episode's
  chapters are written with its row, from the same list that went into the
  MP3, so the two never disagree.
- **Route:** \`/chapters/<guid>.json\`, rendered from those rows on every
  request, before any viewer check, with content type
  \`application/json+chapters\`:

  \`\`\`json
  {"version": "1.2.0", "chapters": [
    {"startTime": 0, "title": "Opening"},
    {"startTime": 41.25, "title": "The funding round"}
  ]}
  \`\`\`

  \`version\` is the chapters format's own version; \`startTime\` is seconds
  from the start, in order.
- Put only letters, digits and hyphens in a \`guid\` used in this path, or
  encode it; Apple asks for ASCII URLs.

## Artwork

Show cover (required by Apple):
- Square, from 1400 x 1400 to 3000 x 3000 pixels; Apple prefers 3000.
- JPEG or PNG, with no transparency and no alpha channel.
- The show's title clear and prominent, with little other text or logos.
- No Apple logos or Apple hardware: Apple may reject the artwork.
- Readable at thumbnail size: one subject, strong contrast, few details.

Episode art (optional, in \`creating-a-podcast-episode\`): the same size and
format rules, with no text and no show logo.

The image generator makes squares of 1024 pixels, below Apple's minimum.
Ask for an opaque, full-bleed background, then convert in Terminal:

\`\`\`
ffmpeg -y -i cover.png -vf "scale=3000:3000:flags=lanczos,format=rgb24" -q:v 3 cover.jpg
\`\`\`

## Hosting

Apple asks for a public feed URL and media that answers \`HEAD\` and
byte-range requests. Rally serves both for files and site assets.

## Apple's categories

Write the category and subcategory exactly as below.

- Arts: Books, Design, Fashion &amp; Beauty, Food, Performing Arts, Visual Arts
- Business: Careers, Entrepreneurship, Investing, Management, Marketing, Non-Profit
- Comedy: Comedy Interviews, Improv, Stand-Up
- Education: Courses, How To, Language Learning, Self-Improvement
- Fiction: Comedy Fiction, Drama, Science Fiction
- Government
- History
- Health &amp; Fitness: Alternative Health, Fitness, Medicine, Mental Health, Nutrition, Sexuality
- Kids &amp; Family: Education for Kids, Parenting, Pets &amp; Animals, Stories for Kids
- Leisure: Animation &amp; Manga, Automotive, Aviation, Crafts, Games, Hobbies, Home &amp; Garden, Video Games
- Music: Music Commentary, Music History, Music Interviews
- News: Business News, Daily News, Entertainment News, News Commentary, Politics, Sports News, Tech News
- Religion &amp; Spirituality: Buddhism, Christianity, Hinduism, Islam, Judaism, Religion, Spirituality
- Science: Astronomy, Chemistry, Earth Sciences, Life Sciences, Mathematics, Natural Sciences, Nature, Physics, Social Sciences
- Society &amp; Culture: Documentary, Personal Journals, Philosophy, Places &amp; Travel, Relationships
- Sports: Baseball, Basketball, Cricket, Fantasy Sports, Football, Golf, Hockey, Rugby, Running, Soccer, Swimming, Tennis, Volleyball, Wilderness, Wrestling
- Technology
- True Crime
- TV &amp; Film: After Shows, Film History, Film Interviews, Film Reviews, TV Reviews

The \`&amp;\` above is how the name is written inside the \`text\` attribute.

## Apps

Apple Podcasts (Library, then Follow a Show by URL), Overcast and Pocket
Casts (add by URL). To list the show in Apple Podcasts, the person submits
the feed URL in Apple Podcasts Connect with their own Apple account.
`;

export const PUBLISHING_A_FEED_SKILL: HarnessSkill = {
  name: "publishing-a-feed",
  description:
    "How to publish any feed an app subscribes to without a Rally sign-in (a podcast, calendar, or news and updates feed): rendered from its own database, with artwork, a page and copyable link, and Apple Podcasts' rules for a podcast.",
  whenToUse:
    "When someone wants a link to add to a podcast app, calendar app or feed reader, or entries that keep arriving by themselves.",
  body: PUBLISHING_A_FEED_BODY,
  ownerPlugin: "rally:terminal",
  resources: [
    { path: "reference/feed-formats.md", body: FEED_FORMATS },
    { path: "reference/apple-podcasts.md", body: APPLE_PODCASTS },
  ],
};
