import appJs from "../../../../canvas-seeds/getting-started-with-canvases/site/app.js";
import indexHtml from "../../../../canvas-seeds/getting-started-with-canvases/site/index.html";
import indexJs from "../../../../canvas-seeds/getting-started-with-canvases/site/index.js";
import readme from "../../../../canvas-seeds/getting-started-with-canvases/site/README.md";
import stylesCss from "../../../../canvas-seeds/getting-started-with-canvases/site/styles.css";

import type { CanvasSeed } from "../services/canvas-seed-service";

/**
 * The guide every new Organization finds in its Canvases list.
 *
 * The site's files are the ones under `canvas-seeds/`, imported as text; this
 * file adds only what a directory cannot say: the Canvas's name and look, the
 * request its creator is recorded as making, and what Rally answers. `docs/canvas-seeds.md`.
 */
export const GETTING_STARTED_WITH_CANVASES: CanvasSeed = {
  key: "getting-started-with-canvases",
  title: "Getting Started with Canvases",
  appearance: { icon: "graduation-cap", color: "blue" },
  // Shown to the whole Organization under its creator's name, and read by
  // Rally on every run. It says in a person's words what the site's README
  // says in full, because the transcript is all Rally is sure to have read.
  request: [
    "Make my team a Getting Started guide as a live page in this Canvas: six things to try, beside a wall where anyone can add an idea and vote. Then help us through it from this Chat:",
    [
      "- We are new to Rally. Keep replies short and plain. Each step asks for one small thing, so do that thing and stop.",
      "- When someone asks for ideas, add them to the wall as cards: one row each in `wall_cards` with `write_artifact_data`, setting only `text` and `asked_by_id`, the id of whoever asked. The data tools are all that needs. Do not read, open or publish the page for it.",
      "- When someone comments on the page, such as to rename the wall, make that one change and publish the page again. Then add a row for them to `guide_steps_done` with the step `comment`.",
      "- When someone gives you their team's name and asks for a section, put the name at the top, add the section, and publish again.",
      "- Only when you have to change the page itself: import the site into your terminal workspace and read its `README.md` before you edit. It has the exact statements and what has to stay as it is.",
      "- All of us share this Chat. Answer when a message is meant for you, and stay out of it when we talk to each other.",
    ].join("\n"),
  ].join("\n\n"),
  openingMessage: [
    "Here is your guide, on the page beside this Chat. Welcome to Rally. This is a Canvas: a conversation with me, and the things I make from it. The page is one of them, and it is live.",
    "Start with step 1 on the page. When a step asks you to talk to me, copy its prompt and send it here.",
    "Everyone in your Organization shares this Chat. Talk to each other here as you would anywhere. I can tell when a message is meant for me, so there is no need to tag me. Ask for something and I will answer. Chat with a teammate and I will stay out of it.",
  ].join("\n\n"),
  site: {
    path: "getting-started-with-canvases",
    files: [
      { path: "index.html", text: indexHtml },
      { path: "index.js", text: indexJs },
      { path: "app.js", text: appJs },
      { path: "styles.css", text: stylesCss },
      { path: "README.md", text: readme },
    ],
  },
};
