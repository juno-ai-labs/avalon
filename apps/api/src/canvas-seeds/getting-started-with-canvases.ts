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
 * file adds only what a directory cannot say: the Canvas's name and look, and
 * what Rally says first. `docs/canvas-seeds.md`.
 */
export const GETTING_STARTED_WITH_CANVASES: CanvasSeed = {
  key: "getting-started-with-canvases",
  title: "Getting Started with Canvases",
  appearance: { icon: "graduation-cap", color: "blue" },
  openingMessage: [
    "Welcome to Rally. This is a Canvas: a conversation with me, and the things I make from it. The page beside this Chat is one of them, and it is live.",
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
