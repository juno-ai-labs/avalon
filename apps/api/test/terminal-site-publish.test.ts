import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  assertKindTransitionAllowed,
  assetContentType,
  bundleArchive,
  declaresAnonymousSubmissions,
  declaresStorageClass,
  resolveDirectoryPublish,
  type DirectoryEntry,
} from "../src/services/terminal/site-publish";
import { TerminalToolError } from "../src/services/terminal/tools";

function entry(path: string): DirectoryEntry {
  return { path, sizeBytes: 10, sha256: "a".repeat(64) };
}

function refusal(run: () => unknown): TerminalToolError {
  try {
    run();
  } catch (error) {
    if (error instanceof TerminalToolError) return error;
    throw error;
  }
  throw new Error("expected a TerminalToolError");
}

describe("what a published directory becomes", () => {
  it("publishes a root index.js as an active site", () => {
    expect(resolveDirectoryPublish([entry("index.js"), entry("index.html")]))
      .toEqual({ kind: "site", mode: "active", entryPath: "index.js" });
  });

  it("prefers index.js over index.html, because an active site ships both", () => {
    const resolved = resolveDirectoryPublish([entry("index.html"), entry("style.css"), entry("index.js")]);
    expect(resolved).toEqual({ kind: "site", mode: "active", entryPath: "index.js" });
  });

  it("publishes a root index.html alone as a static site", () => {
    expect(resolveDirectoryPublish([entry("index.html"), entry("style.css")]))
      .toEqual({ kind: "site", mode: "static", entryPath: "index.html" });
  });

  it("only counts an entry at the root, not one nested inside", () => {
    // `docs/index.html` is a page of a bundle, not a site's entry point.
    expect(resolveDirectoryPublish([entry("docs/index.html"), entry("notes.txt")]))
      .toEqual({ kind: "archive" });
  });

  it("publishes a multi-file directory with no entry as one archive", () => {
    expect(resolveDirectoryPublish([entry("a.csv"), entry("b.csv"), entry("c.png")]))
      .toEqual({ kind: "archive" });
  });

  it("refuses a one-file directory on the archive branch, the mistaken-document shape", () => {
    const error = refusal(() => resolveDirectoryPublish([entry("report.md")]));
    expect(error.code).toBe("single_file_directory");
    // The error sentence has to carry the recovery, because the models Rally
    // routes to for cost recover from the message alone or not at all.
    expect(error.message).toContain("Publish that file's own path");
    expect(error.message).toContain("index.html");
  });

  it("never refuses a one-file directory whose file is itself an entry", () => {
    expect(resolveDirectoryPublish([entry("index.html")]))
      .toEqual({ kind: "site", mode: "static", entryPath: "index.html" });
    expect(resolveDirectoryPublish([entry("index.js")]))
      .toEqual({ kind: "site", mode: "active", entryPath: "index.js" });
  });

  it("refuses authored files in Rally's derived-asset directory", () => {
    const error = refusal(() => resolveDirectoryPublish([
      entry("index.html"),
      entry(".rally/social-preview.png"),
    ]));

    expect(error.code).toBe("reserved_site_path");
    expect(error.message).toContain("reserved");
  });
});

describe("whether a server module asks for a database", () => {
  it("sees the ordinary exported class declaration", () => {
    expect(declaresStorageClass("export class SiteData extends DurableObject {}")).toBe(true);
  });

  it("sees a named export of a class declared above it", () => {
    expect(declaresStorageClass("class SiteData extends DurableObject {}\nexport { SiteData };")).toBe(true);
    expect(declaresStorageClass("export { SiteData as default, other };")).toBe(true);
  });

  it("does not see a stateless module, which is a working site rather than an error", () => {
    expect(declaresStorageClass("export default { async fetch(request, env) { return env.ASSETS.fetch(request); } };"))
      .toBe(false);
  });

  it("does not mistake an unexported or differently named class for the contract", () => {
    expect(declaresStorageClass("class SiteData {}")).toBe(false);
    expect(declaresStorageClass("export class SiteDataStore {}")).toBe(false);
    expect(declaresStorageClass("export class MySiteData {}")).toBe(false);
  });
});

describe("stored content types", () => {
  it("types the kinds a site is actually built from", () => {
    expect(assetContentType("index.html")).toBe("text/html; charset=utf-8");
    expect(assetContentType("css/app.css")).toBe("text/css; charset=utf-8");
    expect(assetContentType("data/signups.json")).toBe("application/json; charset=utf-8");
    expect(assetContentType("logo.svg")).toBe("image/svg+xml");
  });

  it("falls back to a downloading type rather than guessing a rendering one", () => {
    // Untrusted bytes guessed into a rendering type is how model output gets
    // interpreted as something it is not.
    expect(assetContentType("thing.unknownext")).toBe("application/octet-stream");
    expect(assetContentType("noextension")).toBe("application/octet-stream");
    expect(assetContentType(".hidden")).toBe("application/octet-stream");
  });

  it("ignores case in the extension", () => {
    expect(assetContentType("PHOTO.PNG")).toBe("image/png");
  });
});

describe("archive bundling", () => {
  it("produces a zip a recipient can open, holding every file at its own path", () => {
    const bundle = bundleArchive([
      { path: "a.txt", bytes: new TextEncoder().encode("alpha") },
      { path: "nested/b.txt", bytes: new TextEncoder().encode("beta") },
    ]);
    // The local file header magic — this is a zip, not a tar.
    expect(Array.from(bundle.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const unpacked = unzipSync(bundle);
    expect(Object.keys(unpacked).sort()).toEqual(["a.txt", "nested/b.txt"]);
    expect(new TextDecoder().decode(unpacked["a.txt"])).toBe("alpha");
    expect(new TextDecoder().decode(unpacked["nested/b.txt"])).toBe("beta");
  });

  it("is byte-stable for identical content, so an unchanged republish mints no version", () => {
    const files = [{ path: "a.txt", bytes: new TextEncoder().encode("alpha") }];
    expect(Array.from(bundleArchive(files))).toEqual(Array.from(bundleArchive(files)));
  });
});

describe("kind transitions across republishes of one path", () => {
  it("lets an archive become a site, which is the archive fallback's recovery", () => {
    expect(() => assertKindTransitionAllowed("archive", "site")).not.toThrow();
  });

  it("refuses to turn a live site back into an archive", () => {
    // A URL participants hold is never killed by an accident of file layout.
    const error = refusal(() => assertKindTransitionAllowed("site", "archive"));
    expect(error.code).toBe("site_entry_removed");
    expect(error.message).toContain("Restore an entry file");
  });

  it("leaves every other transition alone", () => {
    for (const previous of ["archive", "file", null] as const) {
      expect(() => assertKindTransitionAllowed(previous, "archive")).not.toThrow();
      expect(() => assertKindTransitionAllowed(previous, "site")).not.toThrow();
    }
    expect(() => assertKindTransitionAllowed("site", "site")).not.toThrow();
  });
});

describe("a site that accepts anonymous submissions", () => {
  it("says so only with the literal export set to true", () => {
    expect(declaresAnonymousSubmissions("export const acceptAnonymousSubmissions = true;")).toBe(true);
    expect(declaresAnonymousSubmissions("export  const acceptAnonymousSubmissions=true")).toBe(true);
    expect(declaresAnonymousSubmissions("export const acceptAnonymousSubmissions = false;")).toBe(false);
    expect(declaresAnonymousSubmissions("export const acceptAnonymousSubmissions = trueish;")).toBe(false);
    expect(declaresAnonymousSubmissions("const acceptAnonymousSubmissions = true;")).toBe(false);
  });
});
