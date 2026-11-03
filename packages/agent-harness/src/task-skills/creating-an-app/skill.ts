import type { HarnessSkill } from "../../index";

/**
 * What "create an app" means in Rally, and the one question to settle before
 * building one.
 *
 * A task skill: it interprets the request and routes to `building-live-sites`,
 * which owns the craft. Rally builds live web sites, not native apps, so a
 * native request is turned toward a site before any work starts.
 *
 * No `ownerPlugin`, so a run without Terminal can still route the request and
 * say what it needs, instead of the skill silently disappearing from the
 * catalog.
 */
const CREATING_AN_APP_BODY = `In Rally, an "app" is a **live web site**: a page or small app Rally serves at a
stable link. Settle what kind of app and who it is for, then build it with
\`building-live-sites\`.

## 1. Decide what kind of app this is

- **Default to a live web site.** Treat "make an app", "build me a tool", "a
  tracker", "a dashboard" and similar as a web site.
- **Native mobile app.** Only when the request clearly asks for an iOS or
  Android app (it names the App Store, Google Play, Swift, Kotlin, an iPhone or
  Android build, or installing on a phone), tell the person Rally does not
  build native iOS or Android apps. Offer to build it as a web site instead,
  which opens on any phone's browser, and wait for their answer before
  building. Do not start native code or a project scaffold.

## 2. Ask who uses it and who sees what, before you build

Unless the request already makes it clear, ask the person one single-choice
question right away, before writing any files. Signing in and privacy are
separate: a signed-in site can still show everyone's data, as a vote does.
Offer these three:

- **Open site**: anyone with the link can use it, with no sign-in, and
  everyone sees the same thing.
- **Signed in, shared**: people sign in with Rally, so the site knows who did
  what, and everyone sees everyone's entries (votes, RSVPs, sign-ups).
- **Signed in, private**: people sign in with Rally, and each person sees only
  their own entries (a journal, a personal tracker, saved settings). You and
  any Sidekick can still see everyone's.

Skip the question when the request already answers it: "for anyone to view"
is open, "everyone sees the results" is signed in and shared, "only their own"
or "personal" is signed in and private.

For **signed in, private**, every table that holds one person's data gets a
\`private_to_viewer\` column holding their viewer id. Rally then keeps those
rows private to that person everywhere it shows the site's data. Shared data,
such as RSVPs or votes, uses any other column name, for example
\`member_id\`. A site can mix both: private notes beside a shared board.

Rally provides sign-in; never build a signup form, password or login page of
your own.

If no one can answer, as in a Sidekick run, build an open site and say in
your reply that sign-in and private entries can be added.

## 3. Build it

Load Terminal and \`building-live-sites\`, and follow it. An open site with no
saved data is static or active; a site that remembers what visitors do, or a
signed-in site, follows its stateful and viewer-identity sections. Loading this
skill does not give you Terminal; if Terminal is not available, say the app
needs it.

## Anti-patterns

- **Building first, asking later.** Changing an open site into a signed-in
  one, or shared entries into private ones, means rewriting its storage. Ask
  before the first file.
- **Treating sign-in as privacy.** Signing in tells the site who acted; it
  does not hide anyone's entries. Only a \`private_to_viewer\` column does.
- **Asking when the answer is given.** If the request already says who uses
  it, build without the question.
- **Saying yes to a native app.** Rally cannot ship to an app store. Offer the
  web site instead.`;

export const CREATING_AN_APP_SKILL: HarnessSkill = {
  name: "creating-an-app",
  description:
    "What \"create an app\" means in Rally: a live web site, never a native iOS or Android app, and whether it is open, signed in and shared, or signed in and private, settled before building.",
  whenToUse:
    "When someone asks to create, make or build an app, tool or small program for people to use.",
  body: CREATING_AN_APP_BODY,
};
