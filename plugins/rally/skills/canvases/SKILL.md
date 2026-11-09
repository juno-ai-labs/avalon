---
name: canvases
description: Work with Rally Canvases through the Rally MCP server. Use when the person asks to find, create, update, share, review or tidy up a Rally Canvas, to have Rally make or change a document, spreadsheet, site or other artifact in one, or to publish something already made here (an artifact, a file, a page) to Rally.
---

# Rally Canvases

A **Canvas** in Rally is a shared conversation with Rally (its **Chat**) and
the artifacts that conversation generates: documents, spreadsheets, images,
PDFs and live sites. Everyone the Canvas is shared with can read the Chat and
take part. The Rally tools act in one Organization as the person who connected
Rally, with exactly their permissions.

## Finding a Canvas

1. `list_canvases` with a `query` taken from the title the person used.
2. `get_canvas` on the match for its artifacts, participants, and whether the
   person can manage it.
3. Ask before creating a new Canvas when a close match exists.

## Making or changing work

Rally, the agent inside the Canvas, does the work. You ask it:

1. `send_canvas_message` with a clear request ("Add a risks section to the
   launch plan", "Turn the table into a chart"). Use a fresh UUID as
   `operationId`.
2. Rally answers asynchronously. `read_canvas_chat` to follow along; if it is
   still working, wait and read again rather than resending.
3. `get_canvas` shows each artifact's new version; `read_artifact` reads one.

To start something new, `create_canvas` with a `prompt` creates the Canvas
and sends the prompt as the first message in one step.

## Publishing work made here

When the person wants something you already made (an artifact in this
conversation, a file in the workspace) in Rally, publish it rather than
pasting it into a message:

- `publish_file` for a document, spreadsheet, image or PDF. Name it with its
  extension (`launch-plan.md`, `q3.csv`); send text as text and anything else
  as base64.
- `publish_site` for a web page or front end: `index.html` plus any CSS,
  scripts and images it loads. A single HTML artifact is one file,
  `index.html`. It goes live at its own address.

Publishing the same name again updates the artifact and keeps its history;
choose a new name only for a separate artifact. Then share the returned `url`.

## Sharing and access

- `list_people` turns names into user ids.
- `set_canvas_audience` replaces the whole list: read `get_canvas` first and
  send everyone who should keep access. `workspace` visibility opens it to the
  whole Organization.
- `invite_canvas_guests` shares by email with people outside the Organization.
- `decide_canvas_access_request` approves or denies a waiting request, listed
  in `get_canvas` as `pendingAccessRequests`.

Only a Canvas's managers (its creator, the Organization's owners and admins)
can change its audience, share it, or decide requests. When Rally refuses,
report the refusal; do not retry with other arguments.

## Upkeep

- `update_canvas` retitles a Canvas or sets its icon and colour.
- `rename_artifact` renames an artifact.
- `pin_canvas` pins it in the person's own list.

## Retries

Every tool that takes an `operationId` is safe to call again with the same
`operationId` and arguments after a timeout or unclear result. Never mint a
new one for a retry: that would create a second Canvas or send the message
twice.
