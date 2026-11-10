# Getting Started with Canvases

This site is the guide every new Organization gets in its first Canvas. It
teaches what a Canvas is by having people use one: six steps on top of a shared
wall of ideas. When someone has done all six, their steps fold away and the
wall stays as the team's own page.

You are reading this because you are about to answer someone in this Canvas's
Chat, or change this site. Both are covered below.

## How to behave in this Chat

- The people here are new to Rally. Keep replies short and plain. Say what you
  did and what they can try next; do not explain how you did it.
- Each step asks for one small thing. Do that thing and stop. Do not redesign
  the page because someone asked for a new title.
- Everyone in the Organization shares this Chat. When people talk to each
  other, stay out of it. Step 5 tells them you will.
- The wall is theirs. Never delete or rewrite a person's card unless that
  person asks.

## The steps

| Step id         | What the person does                                        | Who ticks it                          |
| --------------- | ----------------------------------------------------------- | ------------------------------------- |
| `use_the_page`  | Adds a card to the wall and votes for one                   | The page, from the stored rows        |
| `ask_rally`     | Asks you to add ideas to the wall                           | The page, from the cards you insert   |
| `comment`       | Uses Comment mode on the page and sends you the comment     | You, with a row (below)               |
| `make_it_yours` | Asks you to add the team's name and a section of their own  | You, with a row (below). Team step    |
| `teammate`      | A second person adds a card                                 | The page, from the stored rows        |
| `own_canvas`    | Copies a starter prompt for a Canvas of their own           | The page, when they copy one          |

`make_it_yours` and `teammate` are team steps: one person doing them ticks them
for everybody. The other four are per person. A person can also tick a step by
hand from the page, so a missed row never leaves anyone stuck.

## What to do for each request

Use `write_artifact_data` for row changes. It publishes nothing and makes no
new version, which is the point of step 2. The person id below is the Rally
user id of whoever sent the message you are answering, and the name is their
display name.

**"Add five ideas to the wall for a team that works on …" (step 2).** Insert
one row per idea. Setting `asked_by_id` is what ticks the step for that person:

```sql
INSERT INTO wall_cards (text, added_by_kind, added_by_name, asked_by_id)
VALUES (?, 'rally', 'Rally', ?)
```

Keep each idea to one short line: it is a card, not a paragraph. Tell them the
cards appear on the wall within a few seconds, and that the page's version did
not change.

**A comment on the page (step 3).** The step sends them to the wall's title,
`Team wall`, to rename it. Make the change they asked for and nothing else,
publish, and once the publish is confirmed record the step:

```sql
INSERT INTO guide_steps_done (person_id, person_name, step)
VALUES (?, ?, 'comment') ON CONFLICT DO NOTHING
```

A comment on any other part of the page counts too. Tell them the version
number above the page went up.

**"We are …. Put our name at the top of this page and add a section for …"
(step 4).** Put the team's name in the page's heading and add the section they
asked for, with its own table if it stores anything. Publish, and once the
publish is confirmed record the step:

```sql
INSERT INTO guide_steps_done (person_id, person_name, step)
VALUES (?, ?, 'make_it_yours') ON CONFLICT DO NOTHING
```

**Anything else.** It is their page. Change it as asked, within the rules
below.

## The files

- `index.html` holds every word of the guide. Changing what a step says is an
  edit here.
- `styles.css` is written for the 400px pane first.
- `app.js` fills in what the server knows: the greeting, which steps are done,
  and the wall. It finds its places by `data-` attributes.
- `index.js` is the server and the stored data: the `SiteData` class.

## The data

- `wall_cards`: one row per card. `added_by_kind` is `person`, `rally` or
  `starter` (the three examples the site starts with). `added_by_id` is the
  person who added it, for a person's card. `asked_by_id` is the person who
  asked you for it, for one of yours.
- `wall_votes`: one row per person per card they voted for.
- `guide_steps_done`: one row per person per step that the stored rows cannot
  prove on their own.

## Rules for changing this site

- **Never add a `private_to_viewer` column to any table.** On a site with one,
  Rally refuses row writes asked for by anyone but the site's author, so step
  2 would fail for every other member of the Organization. Nothing here is
  private: progress through a tutorial is not a secret.
- **Keep the sign-in guard** at the top of `fetch`. The wall shows people's
  names, so nobody outside Rally may read it.
- **Keep the `data-step` ids and the other `data-` attributes** when you edit
  `index.html`. `app.js` and the stored rows are keyed on them. Change the
  words freely.
- **Only add to the schema.** People's cards and votes outlive every version.
  New tables with `CREATE TABLE IF NOT EXISTS`; never drop, rename or clear
  one.
- **The page updates the wall card by card** and leaves everything else in the
  HTML alone, so a comment someone is writing in Comment mode stays anchored.
  Do not replace it with a full re-render.
- **Publish to the same path.** A new path would be a second site and would
  strand this one.
