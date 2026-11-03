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

## 2. Decide who uses it, and ask only when you must

Signing in and privacy are separate: signing in tells the site who did
something, and a signed-in site can still show everyone's entries, as a vote
does. Pick the first of these that fits:

1. **Open site, the default.** Use it whenever the app saves nothing people
   add: it works on what the person types or pastes, or shows content you
   publish with it. A character counter for pasted text, a word or reading-time
   counter, a unit or currency converter, a tip or loan calculator, a JSON or
   CSV formatter, a countdown timer, a color picker, a reference page or a
   dashboard of data you publish. Anyone with the link can use it. **Build it
   without asking.** It may keep one person's preferences in their own browser,
   which needs no sign-in.
2. **Signed in, shared.** The app saves what people add and everyone sees it
   all: a vote, an RSVP list, a sign-up sheet, a kudos wall, a shared board.
3. **Signed in, private.** The app saves what people add and each person sees
   only their own: a journal, a personal tracker, saved settings. You and any
   Sidekick can still see everyone's.
4. **Signed in, anonymous.** The app collects what people add but must never
   record who added what: an anonymous poll, anonymous feedback, an anonymous
   survey. People still open it from Rally to answer, so each person can be
   limited to one answer, but the stored answers carry no identity. Results
   are shared.

An app that saves what people add always needs sign-in: Rally lets anyone
view a site, but only people who open it from Rally can add or change
anything. So never offer an open site for one.

**Ask only when the app saves what people add and the request does not say
who sees it.** Then ask one question, right away and before writing any
files: should everyone see everyone's entries (shared), or should each person
see only their own (private)? Skip it when the request answers it:
"everyone sees the results" is shared; "only their own", "personal" or
"private" is private; "anonymous" is anonymous. A poll or survey whose
request does not mention anonymity is shared.

For **signed in, anonymous**, follow the anonymous section of
\`building-live-sites\`: store answers as counts or as rows with no viewer
id, and, for one answer each, record who has answered in a separate table
that holds no answers. Tell the person in your reply that people answer from
Rally, and that nobody, the site's author included, can see who chose what.

For **signed in, private**, every table that holds one person's data gets a
\`private_to_viewer\` column holding their viewer id. Rally then keeps those
rows private to that person everywhere it shows the site's data. Shared data,
such as RSVPs or votes, uses any other column name, for example
\`member_id\`. A site can mix both: private notes beside a shared board.

Rally provides sign-in; never build a signup form, password or login page of
your own.

If no one can answer, as in a Sidekick run, build an app that saves what
people add as signed in and shared, and say in your reply that entries can be
made private.

## 3. Build it

Load Terminal and \`building-live-sites\`, and follow it. An open site is
static or active; an app that saves what people add follows its stateful and
viewer-identity sections. Loading this
skill does not give you Terminal; if Terminal is not available, say the app
needs it.

## Anti-patterns

- **Asking about a tool that saves nothing.** A counter, converter or
  calculator is an open site. Build it; a question only slows the person down.
- **Building first, asking later.** Changing shared entries into private ones
  means rewriting the site's storage. When you must ask, ask before the first
  file.
- **Treating sign-in as privacy.** Signing in tells the site who acted; it
  does not hide anyone's entries. Only a \`private_to_viewer\` column does.
- **Asking when the answer is given.** If the request already says who uses
  it, build without the question.
- **Saying yes to a native app.** Rally cannot ship to an app store. Offer the
  web site instead.`;

export const CREATING_AN_APP_SKILL: HarnessSkill = {
  name: "creating-an-app",
  description:
    "What \"create an app\" means in Rally: a live web site, never a native iOS or Android app, open by default, with sign-in only when it saves what people add, and whether those entries are shared, private or anonymous.",
  whenToUse:
    "When someone asks to create, make or build an app, tool or small program for people to use.",
  body: CREATING_AN_APP_BODY,
};
