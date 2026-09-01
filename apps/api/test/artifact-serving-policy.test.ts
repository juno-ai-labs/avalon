import { describe, expect, it } from "vitest";

import {
  ARTIFACT_CONTENT_SECURITY_POLICY,
  artifactSecurityHeaders,
  classifyFetchMetadata,
  injectVersionBase,
  refuseUnsafeVersionRequest,
  resolveAssetPath,
  splitVersionMount,
} from "../src/artifacts/serving-policy";

const ORIGIN = "https://3f2504e0-4f89-41d3-9a0c-0305e82c3301-g.rallyusercontent.test";

function request(init: {
  method?: string;
  site?: string | null;
  origin?: string | null;
  headers?: Record<string, string>;
}): Request {
  const headers = new Headers(init.headers ?? {});
  if (init.site !== null && init.site !== undefined) headers.set("sec-fetch-site", init.site);
  if (init.origin !== null && init.origin !== undefined) headers.set("origin", init.origin);
  return new Request(`${ORIGIN}/`, { method: init.method ?? "GET", headers });
}

describe("the page fence", () => {
  it("permits inline script and style, which every model-authored page uses", () => {
    // `default-src 'self'` alone refuses inline code. Inheriting it would break
    // every artifact on its first load, so both directives are written out.
    expect(ARTIFACT_CONTENT_SECURITY_POLICY).toContain("script-src 'self' 'unsafe-inline'");
    expect(ARTIFACT_CONTENT_SECURITY_POLICY).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("fences egress, which is the threat this policy exists for", () => {
    for (const directive of ["default-src 'self'", "connect-src 'self'", "form-action 'self'"]) {
      expect(ARTIFACT_CONTENT_SECURITY_POLICY).toContain(directive);
    }
    // `'unsafe-inline'` must never leak into a directive that governs where the
    // page may talk to.
    const egress = ARTIFACT_CONTENT_SECURITY_POLICY
      .split("; ")
      .filter((directive) => /^(default|connect|form-action)/u.test(directive));
    expect(egress.every((directive) => !directive.includes("unsafe-inline"))).toBe(true);
  });

  it("permits data: images but never a remote host", () => {
    expect(ARTIFACT_CONTENT_SECURITY_POLICY).toContain("img-src 'self' data:");
    expect(ARTIFACT_CONTENT_SECURITY_POLICY).not.toContain("https:");
    expect(ARTIFACT_CONTENT_SECURITY_POLICY).not.toContain("*");
  });

  it("forbids framing outright, because nothing Rally owns frames an artifact", () => {
    // The rail preview is a top-level WebContentsView and the pop-out is a
    // window; an allowlist would invite back the iframe both deliberately avoid.
    expect(ARTIFACT_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(artifactSecurityHeaders()["x-frame-options"]).toBe("DENY");
  });

  it("sends no referrer and lets no shared cache hold a response", () => {
    const headers = artifactSecurityHeaders();
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["cache-control"]).toContain("private");
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("the cross-artifact request fence", () => {
  it("admits the artifact's own same-origin requests", () => {
    expect(classifyFetchMetadata(request({ site: "same-origin", origin: ORIGIN }), ORIGIN))
      .toBe("same_origin");
    expect(classifyFetchMetadata(request({ site: "same-origin", method: "POST", origin: ORIGIN }), ORIGIN))
      .toBe("same_origin");
  });

  it("admits a genuine top-level navigation", () => {
    expect(classifyFetchMetadata(request({ site: "none" }), ORIGIN)).toBe("top_level");
  });

  it("refuses a credentialed simple POST from a sibling artifact, which needs no preflight", () => {
    // Two artifacts are same-*site*, so SameSite does not stop this and CORS
    // only stops A reading the response — B's handler would still have run.
    expect(classifyFetchMetadata(
      request({ site: "same-site", method: "POST", origin: "https://other-g.rallyusercontent.test" }),
      ORIGIN,
    )).toBe("refused");
  });

  it("refuses a same-site GET too, because a model handler may treat GET as a write", () => {
    expect(classifyFetchMetadata(request({ site: "same-site", origin: null }), ORIGIN)).toBe("refused");
    expect(classifyFetchMetadata(request({ site: "cross-site", origin: null }), ORIGIN)).toBe("refused");
  });

  it("refuses a client that sends no fetch metadata at all", () => {
    // A non-browser caller is treated as not same-origin rather than admitted.
    expect(classifyFetchMetadata(request({ site: null, origin: null }), ORIGIN)).toBe("refused");
  });

  it("refuses a mismatched Origin even when the metadata claims same-origin", () => {
    expect(classifyFetchMetadata(
      request({ site: "same-origin", origin: "https://evil-g.rallyusercontent.test" }),
      ORIGIN,
    )).toBe("refused");
  });

  it("refuses a top-level navigation that is not a GET", () => {
    expect(classifyFetchMetadata(request({ site: "none", method: "POST" }), ORIGIN)).toBe("refused");
  });
});

describe("prior-version mounts", () => {
  it("strips the prefix so a frozen module sees the path it was written against", () => {
    expect(splitVersionMount("/__rally/v3/api/search")).toEqual({ version: 3, path: "/api/search" });
    expect(splitVersionMount("/__rally/v3/")).toEqual({ version: 3, path: "/" });
    expect(splitVersionMount("/__rally/v12")).toEqual({ version: 12, path: "/" });
  });

  it("leaves an ordinary path alone", () => {
    expect(splitVersionMount("/api/search")).toEqual({ version: null, path: "/api/search" });
    expect(splitVersionMount("/")).toEqual({ version: null, path: "/" });
  });

  it("does not treat a malformed or zero version as a mount", () => {
    for (const path of ["/__rally/v0/x", "/__rally/vx/y", "/__rally/v/z", "/__rally/v-1"]) {
      expect(splitVersionMount(path).version).toBeNull();
    }
  });

  it("enforces read-only rather than assuming frozen bytes behave", () => {
    expect(refuseUnsafeVersionRequest(new Request(ORIGIN, { method: "GET" }))).toBeNull();
    expect(refuseUnsafeVersionRequest(new Request(ORIGIN, { method: "HEAD" }))).toBeNull();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(refuseUnsafeVersionRequest(new Request(ORIGIN, { method }))).not.toBeNull();
    }
  });

  it("refuses a service worker, whose scope would outlive the historical view", () => {
    const worker = new Request(ORIGIN, { headers: { "service-worker": "script" } });
    expect(refuseUnsafeVersionRequest(worker)).toContain("service worker");
  });

  it("injects a base before anything that could resolve a URL", () => {
    const html = injectVersionBase("<html><head><link rel=stylesheet href=app.css></head></html>", 3);
    expect(html).toContain('<base href="/__rally/v3/">');
    expect(html.indexOf("<base")).toBeLessThan(html.indexOf("<link"));
  });

  it("still injects a base into markup with no head element", () => {
    expect(injectVersionBase("<p>hi</p>", 2)).toContain('<base href="/__rally/v2/">');
  });

  it("handles a head element carrying attributes", () => {
    const html = injectVersionBase('<head data-theme="dark"><title>x</title></head>', 5);
    expect(html.indexOf("<base")).toBeLessThan(html.indexOf("<title"));
  });
});

describe("asset resolution", () => {
  const assets = new Set(["index.html", "style.css", "docs/index.html", "about.html"]);

  it("serves index.html for the root", () => {
    expect(resolveAssetPath("/", assets)).toBe("index.html");
  });

  it("serves an exact file", () => {
    expect(resolveAssetPath("/style.css", assets)).toBe("style.css");
  });

  it("resolves a directory-shaped path to its index", () => {
    expect(resolveAssetPath("/docs", assets)).toBe("docs/index.html");
    expect(resolveAssetPath("/docs/", assets)).toBe("docs/index.html");
  });

  it("resolves an extensionless route to its html file", () => {
    expect(resolveAssetPath("/about", assets)).toBe("about.html");
  });

  it("resolves nothing outside the manifest, which is what makes index.js a 404", () => {
    // The server module is stored but deliberately absent from `assets`, so a
    // viewer asking for it gets nothing rather than the site's own source.
    expect(resolveAssetPath("/index.js", assets)).toBeNull();
    expect(resolveAssetPath("/../secret", assets)).toBeNull();
    expect(resolveAssetPath("/nothing.png", assets)).toBeNull();
  });

  it("returns null for a root request on a site with no index", () => {
    expect(resolveAssetPath("/", new Set(["only.css"]))).toBeNull();
  });
});
