---
name: canvases
description: Work with Rally Canvases through the Rally MCP server. Use when the person asks to find, create, update, share, review or tidy up a Rally Canvas, or to have Rally make or change a document, spreadsheet, site or other artifact in one.
---

# Rally Canvases

A **Canvas** in Rally is a shared conversation with Rally (its **Chat**) and
the one artifact that conversation makes: a document, spreadsheet, image,
PDF or reactive site. Everyone the Canvas is shared with can read the Chat and
take part. The Rally tools act in one Organization as the person who connected
Rally, with exactly their permissions.

## Finding a Canvas

1. `list_canvases` with a `query` taken from the title the person used.
2. `get_canvas` on the match for its artifact, participants, and whether the
   person can manage it.
3. Ask before creating a new Canvas when a close match exists.

## Making or changing work

Rally, the agent inside the Canvas, does the work. You ask it:

1. `send_canvas_message` with a clear request ("Add a risks section to the
   launch plan", "Turn the table into a chart").
2. Rally answers asynchronously. `read_canvas_chat` to follow along; if it is
   still working, wait and read again rather than resending.
3. `get_canvas` shows the artifact's new version; `read_artifact` reads it.

To start something new, `create_canvas` with a `prompt` creates the Canvas
and sends the prompt as the first message in one step.

## Bringing in work made elsewhere

To put something already made (an artifact, a file, a page) into a Canvas,
use the `publishing` skill: publish it, do not paste it into a message.

## Sharing and access

- `list_people` turns names into user ids.
- `set_canvas_audience` replaces the whole list: read `get_canvas` first and
  send everyone who should keep access. `userIds` is required even when only
  changing artifact access: copy the current `participantUserIds` to preserve
  editors, including guests. `workspace` visibility opens it to the
  whole Organization for editing and conversation access.
- `artifactVisibility` separately controls all published artifacts: `editors`,
  `participants`, `workspace`, or `public`. Use `artifactUserIds` for selected
  artifact users; these people do not gain Chat access. Editors always retain
  artifact access. Send the full list for each supplied audience.
- Pass `get_canvas.sharingRevision` as `expectedRevision` when saving. A conflict
  means read again and reconcile the current audiences before retrying.
- Omitted artifact settings are preserved for older editor-only calls. Artifact
  changes propagate asynchronously over Cloudflare Queues.
- `get_artifact_link` returns a stable artifact URL from its resourceId without
  creating a viewer session. Public artifact access never opens the Chat.
- `invite_canvas_guests` invites guest editors by email. They can read and converse in the Canvas; use artifactUserIds for artifact-only guests already in the Organization.
- `decide_canvas_access_request` approves or denies a waiting request, listed
  in `get_canvas` as `pendingAccessRequests`.

## Keeping a Canvas up to date

A Sidekick is an agent Rally runs for the person, on a schedule or when
something happens (a new email, a pull request opened, closed or merged), with
the person's connected accounts. Give a Canvas one when the person wants it
kept current without asking each time.

- `add_canvas_sidekick` makes one for an existing Canvas; `create_canvas` with
  `sidekick` makes one with a new Canvas. Use a fresh UUID as its
  `operationId`, never the Canvas's.
- Write `instructions` as you would brief a colleague: what starts a run,
  which artifact it updates (by the title or `resourceId` from `get_canvas`)
  and how, and what it leaves alone.
- The call makes the Sidekick and hands your instructions to Rally's setup
  agent. It is a **draft** until that agent saves it, and the agent may ask
  the person a question in Rally. Check `sidekicks` in `get_canvas`; say
  "active" only when the status says so.
- Tell the person it runs as them, with their connected accounts, and that
  everyone in the Canvas can change or stop it.
- To change or stop one, ask in the Canvas's Chat with `send_canvas_message`.
  Archiving the Canvas in Rally stops the Sidekicks made for it.

## Upkeep

- `update_canvas` retitles a Canvas or sets its icon and colour.
- `rename_artifact` renames an artifact.
- `pin_canvas` pins it in the person's own list.
