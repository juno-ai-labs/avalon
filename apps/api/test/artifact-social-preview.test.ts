import type { ArtifactSocialPreview } from "@rally/contracts";
import { describe, expect, it } from "vitest";

import {
  injectSocialPreviewIntoHtml,
  socialPreviewMarkup,
} from "../src/artifacts/social-preview";

const PREVIEW: ArtifactSocialPreview = {
  title: `Launch "status" & risks`,
  description: "Milestones < decisions",
  image: {
    path: ".rally/social-preview.png",
    contentType: "image/png",
    width: 1200,
    height: 630,
    alt: `Launch "status" & risks`,
    generated: true,
  },
};

describe("artifact social preview markup", () => {
  it("emits complete absolute Open Graph and Twitter metadata", () => {
    const markup = socialPreviewMarkup(
      PREVIEW,
      new URL("https://clear-coral-g.rallyusercontent.test/report?viewer=1#top"),
      7,
    );

    expect(markup).toContain(`property="og:type" content="website"`);
    expect(markup).toContain(`property="og:url" content="https://clear-coral-g.rallyusercontent.test/report"`);
    expect(markup).toContain(`property="og:image" content="https://clear-coral-g.rallyusercontent.test/.rally/social-preview.png?v=7"`);
    expect(markup).toContain(`property="og:image:width" content="1200"`);
    expect(markup).toContain(`name="twitter:card" content="summary_large_image"`);
    expect(markup).toContain(`Launch &quot;status&quot; &amp; risks`);
    expect(markup).not.toContain("viewer=1");
  });

  it("creates a head when generated HTML omitted one", () => {
    const source = "<!doctype html><html><body><h1>Report</h1></body></html>";
    const injected = injectSocialPreviewIntoHtml(source, "<meta property=\"og:title\" content=\"Report\">");

    expect(injected).toContain("<html><head>");
    expect(injected.indexOf("og:title")).toBeLessThan(injected.indexOf("<body>"));
  });
});
