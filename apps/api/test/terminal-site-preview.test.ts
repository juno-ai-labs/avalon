import { ArtifactHostnameStubSchema, artifactOrigin } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import { previewSite } from "../src/services/terminal/site-preview";

const DOMAIN = "rallyusercontent.test";
const SITE = artifactOrigin(ArtifactHostnameStubSchema.parse("level-luminous-sequential-schrodinger"), "global", DOMAIN);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

// Browser Rendering cannot run here; the double stands in for the binding only.
function browser(response: Response) {
  const quickAction = vi.fn(async () => response);
  return { quickAction, env: { ARTIFACT_SERVING_DOMAIN: DOMAIN, BROWSER: { quickAction } as never } };
}

describe("preview_site", () => {
  it("renders the site at the pane's width and hands the model the picture", async () => {
    const { quickAction, env } = browser(new Response(PNG, { headers: { "content-type": "image/png" } }));

    const result = await previewSite(env, { url: `${SITE}/` });

    expect(quickAction).toHaveBeenCalledWith("screenshot", expect.objectContaining({
      url: `${SITE}/`,
      viewport: { width: 480, height: 900 },
    }));
    expect(result.contentParts).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==", detail: "auto" } },
    ]);
    expect(result.output).toEqual({ url: `${SITE}/`, width: 480, height: 900, mimeType: "image/png", sizeBytes: 4 });
  });

  it("takes the width and height the model asks for", async () => {
    const { quickAction, env } = browser(new Response(PNG));

    await previewSite(env, { url: `${SITE}/schedule`, width: 1280, height: 800 });

    expect(quickAction).toHaveBeenCalledWith("screenshot", expect.objectContaining({
      url: `${SITE}/schedule`,
      viewport: { width: 1280, height: 800 },
    }));
  });

  it.each([
    "https://example.com/",
    `https://${DOMAIN}.evil.test/`,
    `https://arbitrary.${DOMAIN}/`,
  ])("refuses %s, which is not a Rally-hosted site", async (url) => {
    const { quickAction, env } = browser(new Response(PNG));

    await expect(previewSite(env, { url })).rejects.toMatchObject({ code: "site_preview_url_not_artifact" });
    expect(quickAction).not.toHaveBeenCalled();
  });

  it("names the renderer's status when it cannot render the page", async () => {
    const { env } = browser(new Response("{\"success\":false}", { status: 422 }));

    await expect(previewSite(env, { url: SITE })).rejects.toMatchObject({
      code: "site_preview_failed",
      details: { status: 422 },
    });
  });

  it("says so when the region has no renderer", async () => {
    await expect(previewSite({ ARTIFACT_SERVING_DOMAIN: DOMAIN }, { url: SITE }))
      .rejects.toMatchObject({ code: "site_preview_unavailable" });
  });
});
