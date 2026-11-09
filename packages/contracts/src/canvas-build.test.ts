import { describe, expect, it } from "vitest";

import { detectSiteSource, importedModules } from "./canvas-build";

const component = (body: string, imports = 'import { useState } from "react";') =>
  `${imports}\nexport default function App() { ${body} return <div />; }`;

describe("what a published site's files are", () => {
  it("serves files with an index.html as they are, and refuses a server module", () => {
    expect(detectSiteSource([{ path: "index.html", text: "<h1>Hi</h1>" }, { path: "logo.png", text: null }])).toEqual({ kind: "static" });
    expect(detectSiteSource([{ path: "index.html", text: "" }, { path: "index.js", text: "" }]))
      .toMatchObject({ kind: "refused", code: "canvas_build_server_module" });
  });

  it("builds a project with a build script, whatever else is there, and names one without", () => {
    expect(detectSiteSource([{ path: "package.json", text: '{"scripts":{"build":"vite build"}}' }, { path: "index.html", text: "" }]))
      .toEqual({ kind: "project" });
    expect(detectSiteSource([{ path: "package.json", text: '{"scripts":{"dev":"vite"}}' }]))
      .toMatchObject({ kind: "refused", code: "canvas_build_script_missing" });
    expect(detectSiteSource([{ path: "package.json", text: "{" }])).toMatchObject({ kind: "refused", code: "canvas_build_manifest_invalid" });
  });

  it("builds one default-exported component in Claude's artifact shape, with the libraries and shadcn pieces it provides", () => {
    const dashboard = component("", `import { LineChart } from "recharts";
import { TrendingUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { helper } from "./helper";`);
    expect(detectSiteSource([{ path: "Dashboard.jsx", text: dashboard }, { path: "helper.js", text: "export const helper = 1;" }]))
      .toEqual({ kind: "component", entry: "Dashboard.jsx" });
  });

  it("refuses a component before any sandbox starts when it imports what the build does not provide", () => {
    expect(detectSiteSource([{ path: "Scene.jsx", text: component("", 'import * as THREE from "three";') }]))
      .toMatchObject({ kind: "refused", code: "canvas_build_unsupported_import:three" });
    expect(detectSiteSource([{ path: "Form.tsx", text: component("", 'import { Select } from "@/components/ui/select";') }]))
      .toMatchObject({ kind: "refused", code: "canvas_build_unsupported_import:@/components/ui/select" });
  });

  it("names what it cannot decide between, and what is no page at all", () => {
    expect(detectSiteSource([{ path: "A.jsx", text: component("") }, { path: "B.jsx", text: component("") }]))
      .toMatchObject({ kind: "refused", code: "canvas_build_entry_ambiguous" });
    expect(detectSiteSource([{ path: "notes.md", text: "# Notes" }])).toMatchObject({ kind: "refused", code: "canvas_build_entry_missing" });
  });

  it("reads static, re-exported, dynamic and required imports", () => {
    expect(importedModules(`import a from "a"; import "b"; export { c } from "c"; await import("d"); require("e");`).sort())
      .toEqual(["a", "b", "c", "d", "e"]);
  });
});
