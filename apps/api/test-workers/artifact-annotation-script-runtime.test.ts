/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";

import { injectAnnotationScriptResponse } from "../src/artifacts/annotation-script";

/**
 * The annotation script on an active site's streamed response, on real
 * workerd: `HTMLRewriter` is the runtime's, and what matters is where the
 * script lands relative to what the page authored.
 */
const PATH = "/__rally/picker-0123abcd.js";
const TAG = `<script src="${PATH}"></script>`;

function stream(html: string, headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" }): Response {
  const encoder = new TextEncoder();
  const chunks = [html.slice(0, Math.floor(html.length / 2)), html.slice(Math.floor(html.length / 2))];
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers });
}

describe("annotation script HTML rewriting in workerd", () => {
  it("puts the script first in the head, before the page's own metadata", async () => {
    const response = injectAnnotationScriptResponse(stream(
      "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'\"><title>Page</title></head><body>Body</body></html>",
    ), PATH);
    const body = await response.text();
    expect(body).toContain(`<head>${TAG}<meta http-equiv`);
    expect(body.indexOf(TAG)).toBeLessThan(body.indexOf("<title>"));
    expect(body.split(TAG)).toHaveLength(2);
  });

  it("creates a head for a page that implied one, without buffering", async () => {
    const response = injectAnnotationScriptResponse(stream("<!doctype html><html><body>Body</body></html>"), PATH);
    const body = await response.text();
    expect(body).toContain(`<head>${TAG}</head><body>`);
  });

  it("leaves a protected site's refusal and an API's JSON byte for byte alone", async () => {
    const refused = injectAnnotationScriptResponse(stream("Open this site from Rally.", { "content-type": "text/html" }), PATH);
    const json = injectAnnotationScriptResponse(Response.json({ ok: true }), PATH);
    expect(refused.status).toBe(200);
    const refusedBody = await injectAnnotationScriptResponse(new Response("Open this site from Rally.", { status: 401, headers: { "content-type": "text/html" } }), PATH).text();
    expect(refusedBody).toBe("Open this site from Rally.");
    expect(await json.json()).toEqual({ ok: true });
    await refused.text();
  });
});
