import { describe, expect, it } from "vitest";

import { CanvasPublishPathSchema, CanvasPublishRequestSchema } from "./canvases";

const page = { encoding: "text" as const, data: "<h1>Hi</h1>" };

describe("a publish's paths", () => {
  it("accepts named relative segments and refuses anything that could escape or alias them", () => {
    expect(CanvasPublishPathSchema.safeParse("docs/plan.md").success).toBe(true);
    for (const path of ["../secrets", "docs/../plan.md", "/etc/passwd", "docs//plan.md", "./plan.md", "docs\\plan.md", "plan\u0000.md", ""]) {
      expect(CanvasPublishPathSchema.safeParse(path).success, path).toBe(false);
    }
  });

  it("refuses a site's reserved directory and a repeated path in the request itself", () => {
    const site = (files: Array<{ path: string }>) => CanvasPublishRequestSchema.safeParse({ kind: "site", name: "site",
      files: files.map((file) => ({ ...file, content: page })) });
    expect(site([{ path: "index.html" }, { path: "app.css" }]).success).toBe(true);
    // A lone component has no index.html; what it is is detection's to decide.
    expect(site([{ path: "Dashboard.jsx" }]).success).toBe(true);
    expect(site([{ path: "index.html" }, { path: ".rally/preview.png" }]).success).toBe(false);
    expect(site([{ path: "index.html" }, { path: "index.html" }]).success).toBe(false);
  });
});
