import { Hono } from "hono";

import type { HonoAppEnv } from "../env";
import { randomToken } from "../lib/crypto";
import { approveConversationAccess, type ApprovalOutcome } from "../services/conversation-access-request-service";
import { escapeHtml } from "../services/resend";

/** A sealed approval is two base64url halves; anything else never reaches the decrypt. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{1,4096}$/u;

/**
 * The approve link in an access-request email. Public: the sealed token is the
 * authority, and it names its approver.
 *
 * The link itself grants nothing. A `GET` serves a page that posts the token
 * back at once, so the approver's one click approves, while a mail scanner or
 * link preview that only fetches the URL leaves access unchanged
 * (`docs/channel-access-requests.md`).
 */
export const conversationAccessRoutes = new Hono<HonoAppEnv>();

conversationAccessRoutes.get("/approve", (c) => {
  const token = c.req.query("token") ?? "";
  if (!TOKEN_PATTERN.test(token)) return page(400, "This link is not valid", "Ask them to request access again.");
  const nonce = randomToken(16);
  return page(200, "Approving access…", "", `<form id="approve" method="post" action="/conversation-access/approve">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <noscript><button type="submit">Approve access</button></noscript>
    </form>
    <script nonce="${nonce}">document.getElementById("approve").submit();</script>`, nonce);
});

conversationAccessRoutes.post("/approve", async (c) => {
  const contentType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return page(400, "This link is not valid", "Ask them to request access again.");
  const form = new URLSearchParams(await c.req.text());
  const token = form.get("token") ?? "";
  if (form.getAll("token").length !== 1 || !TOKEN_PATTERN.test(token)) {
    return page(400, "This link is not valid", "Ask them to request access again.");
  }
  return outcomePage(await approveConversationAccess(c.env, token));
});

function outcomePage(outcome: ApprovalOutcome): Response {
  if (outcome.status === "invalid") return page(400, "This link is not valid", "Ask them to request access again.");
  if (outcome.status === "refused") return page(409, "Access was not changed", escapeHtml(outcome.message));
  return page(200, "Access approved",
    `<strong>${escapeHtml(outcome.requesterName)}</strong> can now open the ${outcome.kind} <strong>${escapeHtml(outcome.title)}</strong>.`);
}

/** Fixed copy; every caller value above is escaped before it reaches here. */
function page(status: 200 | 400 | 409, title: string, message: string, body = "", nonce?: string): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Rally</title>
    <style>body{margin:0;background:#10130f;color:#f2f3ec;font:17px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:grid;min-height:100svh;place-items:center}main{max-width:520px;margin:16px;padding:36px;background:#181b17;border:1px solid #343832;border-radius:18px}.brand{font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#CEDC00}h1{font-size:26px;line-height:1.25;margin:18px 0 12px}p{color:#c9ccc4}button{font:inherit;font-weight:700;border:0;border-radius:10px;background:#CEDC00;color:#11140f;padding:13px 20px;cursor:pointer}</style>
    </head><body><main><div class="brand">Rally</div><h1>${title}</h1>${message ? `<p>${message}</p>` : ""}${body}</main></body></html>`, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; ${nonce ? `script-src 'nonce-${nonce}'; ` : ""}form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    },
  });
}
