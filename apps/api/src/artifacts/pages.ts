/**
 * The three pages the artifact serving Worker serves itself.
 *
 * Rally's own HTML, on an artifact's origin, and deliberately tiny: they are
 * served to people who are not yet authorized, or whose page has just broken,
 * and neither is a moment to be loading anything. They carry no script beyond
 * the one the redeem bootstrap cannot do without, no external asset, and no
 * information about what exists behind the URL.
 */

function page(title: string, body: string, extraHead = ""): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>${extraHead}
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: Canvas; color: CanvasText; padding: 2rem;
  }
  main { max-width: 28rem; text-align: center; }
  h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 0.5rem; }
  p { margin: 0; opacity: 0.75; }
</style>
</head><body><main>${body}</main></body></html>`;
}

/**
 * What anyone without Rally-minted access sees.
 *
 * **It says nothing about what is here**, which is the point rather than
 * terseness for its own sake: knowing a URL grants nothing is the house rule
 * for every resource identifier, and a page that distinguished "no such
 * artifact" from "you may not see this one" would turn the URL space into an
 * oracle. A stranger, a viewer whose visibility ended, and a typo all get this.
 */
export function neutralPage(): string {
  return page(
    "Rally",
    "<h1>Open this from Rally</h1>"
    + "<p>This page is part of a Rally thread. Open it from the thread to view it.</p>",
  );
}

/** What a viewer sees when the model's own server code threw. */
export function plainErrorPage(message: string): string {
  return page("Rally", `<h1>Something went wrong</h1><p>${escapeHtml(message)}</p>`);
}

/**
 * The bootstrap that turns a fragment into a cookie.
 *
 * **The access code arrives in `location.hash`, which a browser never sends to
 * a server.** That is the whole reason this page exists rather than the code
 * riding a query parameter: Cloudflare records whole URLs into the invocation
 * log, the Logpush export, and trace spans, and no redaction in this repository
 * reaches them. Single-use redemption bounds replay, but it cannot keep a
 * secret out of a log, so it is not on its own a compliance story.
 *
 * The page reads the fragment, clears it from the address bar before anything
 * else can observe it, and `POST`s the code in a request body. The endpoint it
 * posts to never serves artifact content, so no artifact document is ever
 * loaded at a location that held the code.
 */
export function redeemBootstrapPage(redeemPath: string): string {
  return page(
    "Rally",
    "<h1>Opening…</h1><p>One moment.</p>"
    + `<form id="f" method="POST" action="${redeemPath}"><input type="hidden" name="code" id="c"><input type="hidden" name="return" id="r"></form>`
    + `<script>
(function () {
  var code = location.hash.slice(1);
  // Where to land after redemption. Only a path; the redeem endpoint reduces
  // it to one on this site whatever it holds.
  var back = new URLSearchParams(location.search).get("return");
  // Clear it from the address bar before the POST, so a screenshot or a
  // shoulder-read of the URL bar never holds a live code.
  history.replaceState(null, "", location.pathname);
  if (!code) { location.replace("/"); return; }
  document.getElementById("c").value = code;
  if (back) document.getElementById("r").value = back;
  document.getElementById("f").submit();
})();
</script>`,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
