---
name: "Repository changes podcast"
description: "Get a morning audio rundown of the most important changes in your repos."
icon: "podcast"
color: "indigo"
tags:
  - developers
---

Create a podcast feed in this Canvas with a short episode each morning about changes in my repositories. Use my timezone unless I name another. Ask only which repositories to cover. Create each new episode at 8 a.m. in my timezone. Cover changes that landed on each repository's default branch, grouping merged pull requests and their commits into a single item.

Use one episode per day of changes. Rank the changes by user impact, operational risk, and importance to the team. Start the audio with the biggest change, then explain what landed and why it matters. Put the ranked list and links to the source PRs or commits in the show notes.

Backfill the previous three completed days in my timezone now. Create an episode only for each day with confirmed changes. Then schedule a Sidekick to cover the previous completed day each morning. Use a stable episode ID for each date so retries update the same entry. If a repository cannot be read, report the coverage gap for that day.

Generate playable audio and add it to the feed with an RSS enclosure when the audio and a feed URL can be served to a podcast client. Keep private repository details within the authorized audience. If RSS subscription or audio generation is unavailable, say which part is missing and keep the show notes and any playable audio in the Canvas.
