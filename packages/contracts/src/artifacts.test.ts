import "../../../tests/isolated-region";
import { describe, expect, it } from "vitest";

import {
  artifactReturnPath,
  artifactSiteOpenPath,
  parseArtifactSiteOpenPath,
  ARTIFACT_RESERVED_PREFIX,
  ARTIFACT_VIEWER_ID_HEADER,
  ARTIFACT_VIEWER_NAME_HEADER,
  ArtifactHostnameRouteSchema,
  ArtifactHostnameStubSchema,
  ArtifactManifestSchema,
  ArtifactSocialPreviewSchema,
  SITE_MANIFEST_MIME_TYPE,
  artifactAssetKey,
  artifactHostLabel,
  artifactIsolateId,
  artifactManifestKey,
  artifactOrigin,
  classifyAttachmentKind,
  parseArtifactHost,
} from "./index";
// A separate subpath, deliberately: `http-headers` stays zod-free so the
// static site can import it without pulling a validation library into a page.
import { RALLY_HEADERS, RALLY_HEADER_PREFIX, rallyHeaderAliases } from "./http-headers";

const ARTIFACT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const HOSTNAME_STUB = ArtifactHostnameStubSchema.parse("level-luminous-sequential-schrodinger");

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    artifactId: ARTIFACT,
    artifactVersion: 3,
    mode: "active",
    stateful: true,
    serverModuleSha256: "a".repeat(64),
    assets: [{
      path: "index.html",
      contentType: "text/html; charset=utf-8",
      sizeBytes: 120,
      sha256: "b".repeat(64),
    }],
    totalBytes: 120,
    publishedAt: "2026-08-29T12:00:00.000Z",
    ...overrides,
  };
}

describe("artifact manifest", () => {
  it("accepts a complete manifest and rejects unknown fields", () => {
    expect(ArtifactManifestSchema.safeParse(manifest()).success).toBe(true);
    expect(ArtifactManifestSchema.safeParse({ ...manifest(), extra: 1 }).success).toBe(false);
  });

  it("refuses an artifact id that is not a UUID, because it is the storage identity", () => {
    expect(ArtifactManifestSchema.safeParse(manifest({ artifactId: "my-site" })).success).toBe(false);
  });

  it("refuses a zero or negative version, so an asset key can never collide with another", () => {
    expect(ArtifactManifestSchema.safeParse(manifest({ artifactVersion: 0 })).success).toBe(false);
    expect(ArtifactManifestSchema.safeParse(manifest({ artifactVersion: -1 })).success).toBe(false);
  });

  it("requires a real digest per asset", () => {
    const bad = manifest({
      assets: [{ path: "a.css", contentType: "text/css", sizeBytes: 1, sha256: "nope" }],
    });
    expect(ArtifactManifestSchema.safeParse(bad).success).toBe(false);
  });

  it("allows a stateless active artifact and a static one", () => {
    expect(ArtifactManifestSchema.safeParse(manifest({ stateful: false })).success).toBe(true);
    const staticManifest = manifest({ mode: "static", stateful: false, serverModuleSha256: null });
    expect(ArtifactManifestSchema.safeParse(staticManifest).success).toBe(true);
  });

  it("carries a normalized social preview without invalidating older manifests", () => {
    expect(ArtifactManifestSchema.safeParse(manifest()).success).toBe(true);
    const socialPreview = {
      title: "Launch status",
      description: "The latest launch status and milestones.",
      image: {
        path: "social-preview.png",
        contentType: "image/png",
        width: 1200,
        height: 630,
        alt: "Launch status",
        generated: false,
      },
    };
    expect(ArtifactManifestSchema.safeParse(manifest({ socialPreview })).success).toBe(true);
    expect(ArtifactSocialPreviewSchema.safeParse({
      ...socialPreview,
      image: { ...socialPreview.image, path: "" },
    }).success).toBe(false);
  });
});

describe("artifact addressing", () => {
  it("folds the region into the label rather than adding a dotted level", () => {
    // Two labels deep is not covered by Universal SSL, so this shape is a TLS
    // decision, not a formatting preference.
    expect(artifactHostLabel(HOSTNAME_STUB, "global")).toBe(`${HOSTNAME_STUB}-g`);
    expect(artifactHostLabel(HOSTNAME_STUB, "enterprise")).toBe(`${HOSTNAME_STUB}-enterprise`);
    expect(artifactHostLabel(HOSTNAME_STUB, "global")).not.toContain(".");
    expect(artifactHostLabel(HOSTNAME_STUB, "enterprise")).not.toContain(".");
  });

  it("round-trips a host back to its artifact and region", () => {
    for (const region of ["global", "enterprise"] as const) {
      const origin = artifactOrigin(HOSTNAME_STUB, region, "rallyusercontent.com");
      expect(parseArtifactHost(new URL(origin).host)).toEqual({
        hostnameStub: HOSTNAME_STUB,
        legacyArtifactId: null,
        region,
      });
    }
  });

  it("tolerates a port, uppercase, and surrounding whitespace on the Host header", () => {
    expect(parseArtifactHost(`  ${HOSTNAME_STUB.toUpperCase()}-G.rallyusercontent.com:8787 `))
      .toEqual({ hostnameStub: HOSTNAME_STUB, legacyArtifactId: null, region: "global" });
  });

  it("returns null for anything that is not an artifact host, rather than throwing", () => {
    // This runs before authorization on the serving hot path, so a
    // non-artifact host must be an ordinary null answer.
    for (const host of ["rallywith.ai", "", "..", `${ARTIFACT}.rallyusercontent.com`, `${ARTIFACT}-us.x`]) {
      expect(parseArtifactHost(host)).toBeNull();
    }
    expect(parseArtifactHost("deadbeef-dead-dead-dead-deadbeefdead-g.rallyusercontent.com"))
      .toBeNull();
  });

  it("does not confuse the two regions, which share a UUID prefix", () => {
    expect(parseArtifactHost(`${HOSTNAME_STUB}-enterprise.rallyusercontent.com`)?.region).toBe("enterprise");
    expect(parseArtifactHost(`${HOSTNAME_STUB}-g.rallyusercontent.com`)?.region).toBe("global");
  });

  it("keeps UUID hosts readable while existing links migrate", () => {
    expect(parseArtifactHost(`${ARTIFACT}-g.rallyusercontent.com`)).toEqual({
      hostnameStub: null,
      legacyArtifactId: ARTIFACT,
      region: "global",
    });
  });

  it("validates immutable hostname routes", () => {
    expect(ArtifactHostnameStubSchema.safeParse(HOSTNAME_STUB).success).toBe(true);
    expect(ArtifactHostnameStubSchema.safeParse("three-word-stub").success).toBe(false);
    expect(ArtifactHostnameRouteSchema.safeParse({
      version: 1,
      hostnameStub: HOSTNAME_STUB,
      artifactId: ARTIFACT,
      region: "global",
    }).success).toBe(true);
  });

  it("keys assets and manifests immutably per version", () => {
    expect(artifactAssetKey(ARTIFACT, 3, "css/app.css"))
      .toBe(`artifact/${ARTIFACT}/v3/assets/css/app.css`);
    expect(artifactManifestKey(ARTIFACT, 3)).toBe(`artifact/${ARTIFACT}/v3/manifest.json`);
    expect(artifactAssetKey(ARTIFACT, 3, "a")).not.toBe(artifactAssetKey(ARTIFACT, 4, "a"));
  });

  it("scopes the loader isolate id to the version, which is the cache contract", () => {
    expect(artifactIsolateId(ARTIFACT, 3)).toBe(`artifact:${ARTIFACT}:v3`);
    expect(artifactIsolateId(ARTIFACT, 3)).not.toBe(artifactIsolateId(ARTIFACT, 4));
  });
});

describe("artifact conventions", () => {
  it("classifies a site manifest as a site, not as text", () => {
    // `+json` would otherwise claim it and route a site into the readable-text
    // paths, where a content read would try to return a manifest as a body.
    expect(classifyAttachmentKind({ mimeType: SITE_MANIFEST_MIME_TYPE })).toBe("site");
    expect(SITE_MANIFEST_MIME_TYPE.endsWith("+json")).toBe(true);
  });

  it("keeps an archive publish distinguishable from a site publish", () => {
    expect(classifyAttachmentKind({ mimeType: "application/zip", fileName: "bundle.zip" }))
      .not.toBe("site");
  });

  it("puts the viewer headers in the product header family, aliases included", () => {
    // The strip that prevents forgery has to cover the superseded spelling too,
    // because every product header reader widens to it.
    for (const header of [ARTIFACT_VIEWER_ID_HEADER, ARTIFACT_VIEWER_NAME_HEADER]) {
      expect(header.startsWith(RALLY_HEADER_PREFIX)).toBe(true);
      expect(header).toBe(header.toLowerCase());
      expect(rallyHeaderAliases(header)).toContain(header);
      expect(rallyHeaderAliases(header).length).toBeGreaterThan(1);
      expect(Object.values(RALLY_HEADERS)).toContain(header);
    }
  });

  it("reserves one prefix, so a version mount needs no second origin", () => {
    expect(ARTIFACT_RESERVED_PREFIX).toBe("/__rally");
    expect(ARTIFACT_RESERVED_PREFIX.startsWith("/")).toBe(true);
    expect(ARTIFACT_RESERVED_PREFIX.endsWith("/")).toBe(false);
  });
});

describe("a site's sign-in return path", () => {
  it("keeps a path and query on the site", () => {
    expect(artifactReturnPath("/rsvp?week=2")).toBe("/rsvp?week=2");
  });

  it("turns anything that could leave the site, or loop back into Rally's routes, into /", () => {
    for (const raw of [null, "", "rsvp", "//evil.example/x", "/a/..//evil.example", "/.//evil.example", "/%2e//evil.example", "/\\evil.example", "https://evil.example/", "/__rally/sign-in", "/__rally", "/a\nb"]) {
      expect(artifactReturnPath(raw), String(raw)).toBe("/");
    }
  });

  it("round-trips through the browser client's site-opening path, query included", () => {
    const path = artifactSiteOpenPath("global", "level-luminous-sequential-schrodinger", "/rsvp?week=2");
    expect(path).toBe("/app/sites/global/level-luminous-sequential-schrodinger/%2Frsvp%3Fweek%3D2");
    expect(parseArtifactSiteOpenPath(path)).toEqual({
      region: "global", hostnameStub: "level-luminous-sequential-schrodinger", returnPath: "/rsvp?week=2",
    });
  });

  it("reads no site from any other browser path, and a bad return path as /", () => {
    expect(parseArtifactSiteOpenPath("/app/workspaces/global/x")).toBeNull();
    expect(parseArtifactSiteOpenPath("/app/sites/global/stub/%2F%2Fevil.example")?.returnPath).toBe("/");
  });
});
