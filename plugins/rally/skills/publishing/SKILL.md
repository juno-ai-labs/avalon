---
name: publishing
description: Publish work made here into a Rally Canvas through the Rally MCP server, exactly as it is. Use when the person asks to put, share, publish, send or save something already made in this conversation or workspace (an artifact, a document, a spreadsheet, an image, a web page, a React component, a project) to Rally.
---

# Publishing to Rally

Publishing puts something you already made into a Canvas as one of its
artifacts, byte for byte, as the person. Everyone who can open the Canvas sees
it, and Rally can read and work on it there. Publishing is better than pasting
into a message: the artifact keeps its type, its versions and its address.

## Choose the Canvas

`list_canvases` with words from what the person called it. If nothing fits,
`create_canvas` (without a prompt) and publish into the new one.

## Choose the tool

- **`publish_file`** for a document, spreadsheet, image, PDF or any other
  file. Name it with its extension (`launch-plan.md`, `q3.csv`,
  `chart.png`), and keep the name to update it later. Send text as text and anything else as base64.
- **`publish_site`** for anything that runs in a browser. It goes live at its
  own address. Send it in the shape you have:
  - an HTML artifact: one file named `index.html`, plus any CSS, scripts and
    images it loads;
  - a React artifact: its one `.jsx` or `.tsx` file, **unchanged**. Rally
    builds it with Tailwind and the libraries the `publish_site` tool lists,
    opens it in a browser, and refuses it with the error if it throws or shows
    nothing. Do not wrap it in HTML or bundle it yourself;
  - a project: its folder with `package.json`. Rally builds it with its own
    `build` script.

A component that imports a library Rally does not provide is refused before
anything runs, naming the import. Rewrite it without that library, or publish
the built output (with its `index.html`) instead.

## After publishing

Give the person the returned `url`. If they want others to see it, use the
`canvases` skill's sharing steps. If a build was refused, show the error and
fix the source rather than retrying unchanged.

Use `get_artifact_link` with the published resourceId for its stable file/site
URL. New files may need a moment for background delivery before that link is
ready. Publishing does not make an artifact public: use `set_canvas_audience`
to choose the artifact audience while preserving the editor audience. Changing
artifact visibility applies to every published output in that Canvas.
