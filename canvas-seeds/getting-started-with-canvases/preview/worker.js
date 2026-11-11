// A local stand-in for Rally's artifact runtime, for looking at the guide
// before it is seeded anywhere. It runs the site's own `SiteData` class on
// workerd against real Durable Object SQLite, the way production does, and
// supplies the three things Rally would: the viewer headers, the published
// files, and the Chat's row writes.
//
// Nothing here ships. The site under ../site is the artifact; this file only
// hosts it. Run it with `pnpm preview:canvas-guide`.

import { DurableObject } from "cloudflare:workers";
import { SiteData } from "../site/index.js";

/** The people a preview can look as. Ids stand in for Rally user ids. */
const PEOPLE = {
  maya: { id: "0b9c1f8e-0000-4000-8000-00000000a001", name: "Maya Chen" },
  theo: { id: "0b9c1f8e-0000-4000-8000-00000000a002", name: "Theo Park" },
  priya: { id: "0b9c1f8e-0000-4000-8000-00000000a003", name: "Priya Shah" },
};

/** The ideas the pretend Rally adds, as its answer to step 2's prompt. */
const RALLY_IDEAS = [
  "A welcome page each new customer gets on day one",
  "A tracker for accounts stuck in setup",
  "A weekly digest of onboarding drop-off",
  "A checklist for every kickoff call",
  "A dashboard of time to first value",
];

/**
 * Holds the site's class the way Rally's facet host does: composed, never
 * extended, and given an env that carries the asset reader and nothing else.
 */
export class PreviewHost extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Rally's asset reader takes a path as well as a request, as the site's
    // skill teaches; the local binding wants a whole URL.
    const assets = (input) => env.ASSETS.fetch(typeof input === "string" ? new Request(`https://site.invalid${input}`) : input);
    this.site = new SiteData(ctx, { ASSETS: { fetch: assets } });
  }

  fetch(request) {
    return this.site.fetch(request);
  }

  /** One statement against the site's data, as `write_artifact_data` sends it. */
  write(statement, params) {
    this.ctx.storage.sql.exec(statement, ...params);
  }

  /** Empties the site's data and restarts it, so the starter cards return. */
  async reset() {
    await this.ctx.storage.deleteAll();
    this.ctx.abort("preview reset");
  }
}

function viewerFrom(request) {
  const cookie = request.headers.get("cookie") ?? "";
  const key = /(?:^|;\s*)preview_viewer=(\w+)/.exec(cookie)?.[1];
  return PEOPLE[key] ? { key, ...PEOPLE[key] } : { key: "maya", ...PEOPLE.maya };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = env.HOST.get(env.HOST.idFromName("guide"));
    const viewer = viewerFrom(request);

    if (url.pathname === "/__preview") {
      return new Response(controlsPage(viewer), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/__preview/as" && request.method === "POST") {
      const key = PEOPLE[url.searchParams.get("who")] ? url.searchParams.get("who") : "maya";
      return new Response(null, {
        status: 303,
        headers: { location: "/__preview", "set-cookie": `preview_viewer=${key}; Path=/; SameSite=Lax` },
      });
    }

    if (url.pathname === "/__preview/rally" && request.method === "POST") {
      // Each branch sends the statements README.md gives Rally for that step.
      const action = url.searchParams.get("do");
      if (action === "ideas") {
        for (const idea of RALLY_IDEAS) {
          await host.write(
            "INSERT INTO wall_cards (text, added_by_kind, added_by_name, asked_by_id) VALUES (?, 'rally', 'Rally', ?)",
            [idea, viewer.id],
          );
        }
      } else if (action === "comment" || action === "make_it_yours") {
        await host.write(
          "INSERT INTO guide_steps_done (person_id, person_name, step) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
          [viewer.id, viewer.name, action],
        );
      } else if (action === "reset") {
        await host.reset().catch(() => {});
      }
      return new Response(null, { status: 303, headers: { location: "/__preview" } });
    }

    // Everything else is the site. Rally strips any identity a caller sent
    // and sets its own, so the preview does the same.
    const headers = new Headers(request.headers);
    headers.delete("x-rally-viewer-id");
    headers.delete("x-rally-viewer-name");
    if (url.searchParams.get("signed-out") === null) {
      headers.set("x-rally-viewer-id", viewer.id);
      headers.set("x-rally-viewer-name", encodeURIComponent(viewer.name));
    }
    const response = await host.fetch(new Request(request, { headers }));
    const served = new Response(response.body, response);
    // Rally's policy for an artifact, with the preview's own frame allowed.
    served.headers.set(
      "content-security-policy",
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "media-src 'self' data:",
        "connect-src 'self'",
        "form-action 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'self'",
        "worker-src 'none'",
      ].join("; "),
    );
    return served;
  },
};

/** The preview's frame: who you are, what the pretend Rally does, and the page. */
function controlsPage(viewer) {
  const person = (key) =>
    `<button formaction="/__preview/as?who=${key}" ${viewer.key === key ? 'aria-pressed="true"' : ""}>${PEOPLE[key].name.split(" ")[0]}</button>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview: Getting Started with Canvases</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: grid; grid-template-rows: auto 1fr; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #111; color: #ddd; }
  form { display: flex; flex-wrap: wrap; gap: 6px 18px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #333; }
  fieldset { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 0; padding: 0; border: 0; }
  legend { float: left; margin-right: 6px; padding: 0; color: #999; }
  button { padding: 4px 10px; border: 1px solid #444; border-radius: 6px; background: #222; color: inherit; font: inherit; cursor: pointer; }
  button:hover { border-color: #888; }
  button[aria-pressed="true"] { border-color: #8fb0d8; color: #8fb0d8; }
  .stage { display: grid; justify-items: center; min-height: 0; background: #000; }
  iframe { width: 100%; height: 100%; border: 0; background: #fff; }
  .stage.pane iframe { width: 400px; }
</style>
</head>
<body>
<form method="post">
  <fieldset><legend>Looking as</legend>${person("maya")}${person("theo")}${person("priya")}</fieldset>
  <fieldset><legend>Rally, in the Chat</legend>
    <button formaction="/__preview/rally?do=ideas">Adds five ideas (step 2)</button>
    <button formaction="/__preview/rally?do=comment">Handles a comment (step 3)</button>
    <button formaction="/__preview/rally?do=make_it_yours">Makes it yours (step 4)</button>
  </fieldset>
  <fieldset><legend>Width</legend>
    <button type="button" data-width="pane">400px pane</button>
    <button type="button" data-width="full">Full</button>
  </fieldset>
  <fieldset><button formaction="/__preview/rally?do=reset">Reset data</button></fieldset>
</form>
<div class="stage pane"><iframe src="/" title="The guide"></iframe></div>
<script>
  const stage = document.querySelector(".stage");
  const saved = sessionStorage.getItem("preview-width") ?? "pane";
  stage.classList.toggle("pane", saved === "pane");
  for (const button of document.querySelectorAll("[data-width]")) {
    button.setAttribute("aria-pressed", String(button.dataset.width === saved));
    button.addEventListener("click", () => {
      sessionStorage.setItem("preview-width", button.dataset.width);
      location.reload();
    });
  }
</script>
</body>
</html>`;
}
