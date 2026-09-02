/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";

import { injectSocialPreviewResponse } from "../src/artifacts/social-preview";

describe("artifact social preview HTML rewriting in workerd", () => {
  it("prepends metadata to a streaming HTML head", async () => {
    const response = injectSocialPreviewResponse(new Response(
      "<!doctype html><html><head><title>Page</title></head><body>Body</body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } },
    ), `<meta property="og:title" content="Preview title">`);

    expect(await response.text()).toContain(
      `<head><meta property="og:title" content="Preview title">\n<title>Page</title>`,
    );
  });

  it("fills an implied HTML head without buffering the response", async () => {
    const response = injectSocialPreviewResponse(new Response(
      "<!doctype html><html><body>Body</body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } },
    ), `<meta property="og:title" content="Preview title">`);

    const body = await response.text();
    expect(body).toContain(`<meta property="og:title" content="Preview title">`);
    expect(body.indexOf("og:title")).toBeLessThan(body.indexOf("<body>"));
  });

  it("leaves protected errors and JSON APIs byte-for-byte alone", async () => {
    const protectedResponse = injectSocialPreviewResponse(
      new Response("Open this site from Rally.", {
        status: 401,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      `<meta property="og:title" content="Must not appear">`,
    );
    const jsonResponse = injectSocialPreviewResponse(
      Response.json({ ok: true }),
      `<meta property="og:title" content="Must not appear">`,
    );

    expect(await protectedResponse.text()).toBe("Open this site from Rally.");
    expect(await jsonResponse.json()).toEqual({ ok: true });
  });
});
