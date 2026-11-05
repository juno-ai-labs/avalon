import "../../../tests/isolated-region";
import { artifactAnnotationScriptPath } from "@rally/contracts";
import { describe, expect, it } from "vitest";

import {
  annotationScriptPathFor,
  annotationScriptResponse,
  injectAnnotationScriptIntoHtml,
} from "../src/artifacts/annotation-script";

const APP = "https://app.example.test";

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://stub-g.rallyusercontent.test/", { headers });
}

describe("who gets the annotation script", () => {
  it("gives it to a viewer with a session, framed or not", () => {
    expect(annotationScriptPathFor({ viewerId: "user-1", request: request(), parentOrigin: APP }))
      .toBe(artifactAnnotationScriptPath(APP));
    expect(annotationScriptPathFor({ viewerId: "user-1", request: request(), parentOrigin: null }))
      .toBe(artifactAnnotationScriptPath(null));
  });

  it("gives it to the browser client's frame without a session, which Safari views cookieless", () => {
    expect(annotationScriptPathFor({ viewerId: null, request: request({ "sec-fetch-dest": "iframe" }), parentOrigin: APP }))
      .toBe(artifactAnnotationScriptPath(APP));
  });

  it("gives it to nobody else: a public read, a crawler, a page's own fetch, or a frame with no app to listen to", () => {
    expect(annotationScriptPathFor({ viewerId: null, request: request(), parentOrigin: APP })).toBeNull();
    // A viewer's page fetching a partial sends the cookie too; the partial stays as published.
    expect(annotationScriptPathFor({ viewerId: "user-1", request: request({ "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" }), parentOrigin: APP })).toBeNull();
    expect(annotationScriptPathFor({ viewerId: "user-1", request: request({ "sec-fetch-dest": "document" }), parentOrigin: APP })).toBe(artifactAnnotationScriptPath(APP));
    expect(annotationScriptPathFor({ viewerId: null, request: request({ "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" }), parentOrigin: APP })).toBeNull();
    expect(annotationScriptPathFor({ viewerId: null, request: request({ "sec-fetch-dest": "iframe" }), parentOrigin: null })).toBeNull();
  });
});

describe("the served script", () => {
  it("is JavaScript a browser may not sniff, kept for a year only under this build's own path", async () => {
    const path = artifactAnnotationScriptPath(APP);
    const response = annotationScriptResponse(APP, path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("rallyAnnotations");
    // Another build's path, asked of this isolate during a deploy: served, not cached as that build.
    const stale = annotationScriptResponse(APP, "/__rally/picker-00000000.js");
    expect(stale.status).toBe(200);
    expect(stale.headers.get("cache-control")).toBe("no-store");
  });
});

describe("placing the script in static HTML", () => {
  const path = "/__rally/picker-0123abcd.js";
  const tag = `<script defer src="${path}"></script>`;

  it("goes first in the head, before the page's own metadata and scripts", () => {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><script>page()</script></head><body>Body</body></html>`;
    expect(injectAnnotationScriptIntoHtml(html, path))
      .toBe(`<!doctype html><html lang="en"><head>${tag}<meta charset="utf-8"><script>page()</script></head><body>Body</body></html>`);
  });

  it("creates a head when the page has none", () => {
    expect(injectAnnotationScriptIntoHtml(`<html><body>Body</body></html>`, path))
      .toBe(`<html><head>${tag}</head><body>Body</body></html>`);
    expect(injectAnnotationScriptIntoHtml(`<!doctype html><p>Body</p>`, path))
      .toBe(`<!doctype html><head>${tag}</head><p>Body</p>`);
    expect(injectAnnotationScriptIntoHtml(`<p>Body</p>`, path))
      .toBe(`<head>${tag}</head><p>Body</p>`);
  });

  it("skips a head named inside a comment and finds the real one", () => {
    expect(injectAnnotationScriptIntoHtml(`<!-- template uses <head> --><html><head><title>T</title></head></html>`, path))
      .toBe(`<!-- template uses <head> --><html><head>${tag}<title>T</title></head></html>`);
    expect(injectAnnotationScriptIntoHtml(`<!-- <html> and <head> are below --><html><body>B</body></html>`, path))
      .toBe(`<!-- <html> and <head> are below --><html><head>${tag}</head><body>B</body></html>`);
  });

  it("handles a head element carrying attributes and mixed case", () => {
    expect(injectAnnotationScriptIntoHtml(`<HTML><HEAD data-x="1"><title>T</title></HEAD></HTML>`, path))
      .toBe(`<HTML><HEAD data-x="1">${tag}<title>T</title></HEAD></HTML>`);
  });
});
