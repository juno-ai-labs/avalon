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

  it("refuses a local import or stylesheet reference that names no published file, before the build can read the sandbox's disk", () => {
    const refused = (files: Array<{ path: string; text: string | null }>) => detectSiteSource(files);
    expect(refused([{ path: "App.jsx", text: component("", 'import pkg from "/workspace/package.json";') }]))
      .toMatchObject({ kind: "refused", code: "canvas_build_unsupported_import:/workspace/package.json" });
    expect(refused([{ path: "App.jsx", text: component("", 'import secrets from "../../workspace/.env";') }]))
      .toMatchObject({ kind: "refused", code: "canvas_build_unsupported_import:../../workspace/.env" });
    expect(refused([{ path: "App.jsx", text: component("", 'import { helper } from "./missing";') }]))
      .toMatchObject({ kind: "refused", code: "canvas_build_unsupported_import:./missing" });
    expect(refused([{ path: "App.jsx", text: component("", 'import "./theme.css";') },
      { path: "theme.css", text: '@import "../../workspace/notes.css"; .a { background: url("logo.png"); }' }, { path: "logo.png", text: null }]))
      .toMatchObject({ kind: "refused", code: "canvas_build_unsupported_import:../../workspace/notes.css" });
    expect(refused([{ path: "App.jsx", text: component("", 'import "./theme.css";') },
      { path: "theme.css", text: '.a { background: url(/etc/hostname); }' }]))
      .toMatchObject({ kind: "refused", code: "canvas_build_unsupported_import:/etc/hostname" });
    // What it does publish resolves as esbuild resolves it: with or without an extension, or a folder's index.
    expect(refused([
      { path: "App.jsx", text: component("", 'import { a } from "./lib/a";\nimport { b } from "./lib";\nimport "./styles/theme.css";') },
      { path: "lib/a.ts", text: 'export const a = 1;' }, { path: "lib/index.js", text: 'export const b = 2;' },
      { path: "styles/theme.css", text: '@import "./base.css"; .a { background: url("../logo.png"), url(data:image/png;base64,AA==); }' },
      { path: "styles/base.css", text: "" }, { path: "logo.png", text: null },
    ])).toEqual({ kind: "component", entry: "App.jsx" });
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

  it("does not read an import out of a comment, a string, a template or a regular expression", () => {
    const source = `import { useState } from "react";
// import Chart from "three";
/* import Scene from "three";
   require("three"); */
const sample = "import x from 'three'";
const other = 'require("three")';
const snippet = \`import("three")\`;
const pattern = /import\\("three"\\)/u;
export default function App() { return <p>Don't import "three" here</p>; }`;
    expect(importedModules(source)).toEqual(["react"]);
    expect(detectSiteSource([{ path: "App.jsx", text: source }])).toEqual({ kind: "component", entry: "App.jsx" });
  });

  it("still reads a real import after a line of JSX text with an apostrophe, and inside a template's substitution", () => {
    expect(importedModules(`const a = <p>Don't</p>;
const b = \`\${await import("lodash")}\`;
import * as THREE from "three";`).sort()).toEqual(["lodash", "three"]);
    expect(importedModules("const at = `${'x'}`; const ratio = total / 2; import('d3' /* inline */);")).toEqual(["d3"]);
    expect(importedModules("const path = `three`; import(`recharts`);")).toEqual(["recharts"]);
  });
});
