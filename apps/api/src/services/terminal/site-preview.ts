import type { HarnessToolResult } from "@rally/agent-harness";
import { isArtifactUrl } from "@rally/contracts";

import type { Env } from "../../env";
import { modelImageDataUri } from "../attachment-model-content";

import { TerminalArgumentSchemas } from "./contract";
import { TerminalToolError } from "./tools";

/**
 * About the width of Rally's artifact pane at an even split on a laptop
 * window, which is where a published site is most often first seen. It is the
 * default rather than a limit: the model may ask for any width.
 */
export const SITE_PREVIEW_DEFAULT_WIDTH = 480;
export const SITE_PREVIEW_DEFAULT_HEIGHT = 900;

/**
 * Render a published Rally site the way a viewer's browser would and hand the
 * picture back to the model.
 *
 * The agent writes a site's HTML without ever seeing it. A layout that holds
 * at desktop width and falls apart in the narrow pane is invisible to it, and
 * a participant's "it looks broken" then turns into rounds of CSS edits aimed
 * at the wrong thing. One screenshot at the pane's width closes that loop.
 *
 * Only URLs on Rally's own artifact domain are accepted. The renderer is
 * Cloudflare's, outside the sandbox and its egress policy, so an open URL
 * would make this a browsing tool that ignores the workspace's network
 * setting. An artifact URL shows nothing its own address does not already
 * show anyone who opens it; a protected site renders its gate.
 */
export async function previewSite(
  env: Pick<Env, "BROWSER" | "ARTIFACT_SERVING_DOMAIN">,
  rawInput: unknown,
): Promise<HarnessToolResult> {
  const input = TerminalArgumentSchemas.preview_site.parse(rawInput);
  const url = artifactUrl(input.url, env.ARTIFACT_SERVING_DOMAIN);
  if (!env.BROWSER) {
    throw new TerminalToolError(
      "site_preview_unavailable",
      "Site preview is not available in this Rally region. Check the layout by reading the CSS against the target width instead.",
    );
  }
  const width = input.width ?? SITE_PREVIEW_DEFAULT_WIDTH;
  const height = input.height ?? SITE_PREVIEW_DEFAULT_HEIGHT;
  const response = await env.BROWSER.quickAction("screenshot", {
    url,
    viewport: { width, height },
    screenshotOptions: { type: "png" },
    gotoOptions: { waitUntil: "networkidle2" },
  });
  if (!response.ok) {
    // The renderer's own error body names what it could not do. Only its
    // status crosses: the body may quote the page.
    throw new TerminalToolError(
      "site_preview_failed",
      `The site could not be rendered (status ${response.status}). Confirm the URL is the one publish_resource returned, then try again.`,
      { status: response.status },
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    output: { url, width, height, mimeType: "image/png", sizeBytes: bytes.byteLength },
    summary: `Rendered ${url} at ${width}×${height}`,
    contentParts: [{ type: "image_url", image_url: { url: modelImageDataUri(bytes, "image/png"), detail: "auto" } }],
  };
}

function artifactUrl(raw: string, servingDomain: string): string {
  if (!isArtifactUrl(raw, servingDomain)) throw notAnArtifact();
  return new URL(raw).toString();
}

function notAnArtifact(): TerminalToolError {
  return new TerminalToolError(
    "site_preview_url_not_artifact",
    "preview_site only renders Rally-hosted sites. Pass the url that publish_resource returned for the site.",
  );
}
