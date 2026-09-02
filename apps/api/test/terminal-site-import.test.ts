import { asArtifactId, type ArtifactManifest } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { importTreeFailure, materializeTreeCommand, readArtifactVersionFiles } from "../src/services/terminal/site-import";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";

const DESTINATION = "/workspace/.rally-output/offsite-rsvp";
const STAGING = "/workspace/.rally/tmp/tree-1";

function command(overwrite: boolean): string {
  return materializeTreeCommand({ destination: DESTINATION, staging: STAGING, overwrite });
}

describe("writing a materialized site tree", () => {
  it("leaves Rally's generated preview behind when importing source", async () => {
    const artifactId = asArtifactId("00000000-0000-7000-8000-0000000000b1");
    const manifest: ArtifactManifest = {
      version: 1,
      artifactId,
      artifactVersion: 2,
      mode: "static",
      stateful: false,
      serverModuleSha256: null,
      assets: [
        { path: "index.html", contentType: "text/html", sizeBytes: 1, sha256: "1".repeat(64) },
        { path: ".rally/social-preview-auto.png", contentType: "image/png", sizeBytes: 1, sha256: "2".repeat(64) },
      ],
      socialPreview: {
        title: "Site",
        description: "Site description",
        image: {
          path: ".rally/social-preview-auto.png",
          contentType: "image/png",
          width: 1200,
          height: 630,
          alt: "Site",
          generated: true,
        },
      },
      totalBytes: 2,
      publishedAt: "2026-09-02T00:00:00.000Z",
    };
    const get = vi.fn(async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }));
    const env = {
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({ get }),
    } satisfies Pick<Env, "PAYLOADS">;

    await expect(readArtifactVersionFiles(env, manifest)).resolves.toEqual([
      { path: "index.html", bytes: new Uint8Array([1]) },
    ]);
    expect(get).toHaveBeenCalledOnce();
  });

  it("imports authored preview artwork as source", async () => {
    const artifactId = asArtifactId("00000000-0000-7000-8000-0000000000b1");
    const manifest: ArtifactManifest = {
      version: 1,
      artifactId,
      artifactVersion: 2,
      mode: "static",
      stateful: false,
      serverModuleSha256: null,
      assets: [
        { path: "index.html", contentType: "text/html", sizeBytes: 1, sha256: "1".repeat(64) },
        { path: "social-preview.png", contentType: "image/png", sizeBytes: 1, sha256: "2".repeat(64) },
      ],
      socialPreview: {
        title: "Site",
        description: "Site description",
        image: {
          path: "social-preview.png",
          contentType: "image/png",
          width: 1200,
          height: 630,
          alt: "Site",
          generated: false,
        },
      },
      totalBytes: 2,
      publishedAt: "2026-09-02T00:00:00.000Z",
    };
    const get = vi.fn(async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }));
    const env = {
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({ get }),
    } satisfies Pick<Env, "PAYLOADS">;

    await expect(readArtifactVersionFiles(env, manifest)).resolves.toEqual([
      { path: "index.html", bytes: new Uint8Array([1]) },
      { path: "social-preview.png", bytes: new Uint8Array([1]) },
    ]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("refuses a non-empty destination when no overwrite was asked for", () => {
    expect(command(false)).toContain("exit 44");
    expect(command(false)).toContain('ls -A "$destination"');
  });

  it("replaces the whole tree rather than merging into it", () => {
    // Merging is the dangerous default this rules out: it would leave behind
    // files a later version deleted, and the next publish would ship them back.
    expect(command(true)).toContain('rm -rf -- "$destination"');
    expect(command(true)).not.toContain("exit 44");
  });

  it("stages beside the destination and moves into place", () => {
    // A failure partway leaves the previous tree intact rather than a
    // half-replaced one.
    const staged = command(true);
    expect(staged.indexOf('mv -- "$staging" "$destination"'))
      .toBeGreaterThan(staged.indexOf('rm -rf -- "$destination"'));
  });

  it("refuses a destination that is not a directory, in both modes", () => {
    for (const overwrite of [true, false]) {
      expect(command(overwrite), String(overwrite)).toContain("exit 45");
    }
  });

  it("quotes paths so a name with a quote cannot break out of the command", () => {
    const injected = materializeTreeCommand({
      destination: "/workspace/a'; rm -rf /; echo '",
      staging: STAGING,
      overwrite: true,
    });
    expect(injected).toContain(`'"'"'`);
    expect(injected).not.toMatch(/^destination='\/workspace\/a'; rm/mu);
  });
});

describe("what an import failure tells the model to do", () => {
  it("says nothing succeeded quietly", () => {
    expect(importTreeFailure(0)).toBeNull();
  });

  it("names the two repairs for an occupied destination", () => {
    const failure = importTreeFailure(44);
    expect(failure?.code).toBe("destination_exists");
    expect(failure?.message).toContain("another destinationPath");
    // The word that stops a model expecting a merge.
    expect(failure?.message).toContain("replaces the whole tree");
  });

  it("distinguishes a destination it cannot replace from one that is occupied", () => {
    expect(importTreeFailure(45)?.code).toBe("destination_not_regular");
    expect(importTreeFailure(46)?.code).toBe("resource_import_failed");
  });

  it("carries a repair in every failure it produces", () => {
    for (const code of [44, 45, 46, 99]) {
      expect(importTreeFailure(code)?.details?.reason, String(code)).toBeTruthy();
    }
  });
});
