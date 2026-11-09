#!/usr/bin/env node
// Builds a person's published source into a static site, inside the Canvas's
// Terminal sandbox, then opens it in Chromium and refuses it unless it
// renders. Shipped into the sandbox as text by `canvas-build-service.ts`; runs
// with Node and nothing else of Rally's. `docs/rally-mcp.md#building`.
//
//   node build.sandbox.mjs <request.json>
//
// The request names the source directory, an empty work directory, the kind
// the Worker detected, and for a component its entry file. The last line of
// stdout is the JSON report the Worker reads; everything before it is the
// build's own output, kept for diagnosis.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const request = JSON.parse(await readFile(process.argv[2], "utf8"));

/**
 * The libraries a component may import, at the versions it gets. Claude's
 * artifacts assume these are present; pinning them here, at build time, is
 * what keeps a published site from loading code from anywhere when it is
 * viewed. The list is the team's: `COMPONENT_LIBRARIES` in
 * `packages/contracts/src/canvas-build.ts` mirrors it for the Worker's check.
 */
const TOOLCHAIN = {
  dependencies: {
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "react-is": "19.2.8",
    "lucide-react": "1.70.0",
    "recharts": "3.10.1",
    "lodash": "4.17.21",
    "clsx": "2.1.1",
    "tailwind-merge": "2.6.0",
  },
  devDependencies: {
    "esbuild": "0.28.2",
    "tailwindcss": "3.4.19",
  },
};

class BuildRefusal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function report(value) {
  process.stdout.write(`\n${JSON.stringify(value)}\n`);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"], ...options });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new BuildRefusal(options.failure ?? "canvas_build_failed",
      `${[command, ...args].join(" ")} exited with ${code}`)));
  });
}

async function files(root, directory = root) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await files(root, path));
    else if (entry.isFile()) out.push(relative(root, path));
  }
  return out;
}

/**
 * One toolchain per manifest, installed once into the sandbox and reused by
 * every later build of any Canvas component, so only the first build pays for
 * the install. Keyed by the manifest's digest, so a version change installs a
 * fresh one beside the old.
 */
async function toolchain() {
  const manifest = JSON.stringify(TOOLCHAIN);
  const key = createHash("sha256").update(manifest).digest("hex").slice(0, 16);
  const home = join(process.env.HOME ?? "/tmp", ".rally", "canvas-build", key);
  if (existsSync(join(home, "node_modules", ".rally-ready"))) return home;
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "package.json"), JSON.stringify({ private: true, ...TOOLCHAIN }, null, 2));
  await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: home, failure: "canvas_build_install_failed" });
  await writeFile(join(home, "node_modules", ".rally-ready"), new Date().toISOString());
  return home;
}

/** The shadcn/ui pieces Claude's artifacts import from `@/components/ui/*`, written for this build. */
const SHADCN = {
  // shadcn's own helper: a later class overrides a conflicting earlier one.
  "lib/utils.js": `import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...values) { return twMerge(clsx(values)); }`,
  "components/ui/card.jsx": `import { cn } from "@/lib/utils";
export const Card = ({ className, ...props }) => <div className={cn("rounded-xl border bg-white text-slate-950 shadow-sm", className)} {...props} />;
export const CardHeader = ({ className, ...props }) => <div className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />;
export const CardTitle = ({ className, ...props }) => <h3 className={cn("text-lg font-semibold leading-none tracking-tight", className)} {...props} />;
export const CardDescription = ({ className, ...props }) => <p className={cn("text-sm text-slate-500", className)} {...props} />;
export const CardContent = ({ className, ...props }) => <div className={cn("p-6 pt-0", className)} {...props} />;
export const CardFooter = ({ className, ...props }) => <div className={cn("flex items-center p-6 pt-0", className)} {...props} />;`,
  "components/ui/button.jsx": `import { cn } from "@/lib/utils";
const variants = { default: "bg-slate-900 text-white hover:bg-slate-800", outline: "border border-slate-200 bg-white hover:bg-slate-100",
  secondary: "bg-slate-100 text-slate-900 hover:bg-slate-200", ghost: "hover:bg-slate-100", destructive: "bg-red-600 text-white hover:bg-red-700", link: "text-slate-900 underline-offset-4 hover:underline" };
const sizes = { default: "h-10 px-4 py-2", sm: "h-9 rounded-md px-3", lg: "h-11 rounded-md px-8", icon: "h-10 w-10" };
export const Button = ({ className, variant = "default", size = "default", ...props }) =>
  <button className={cn("inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50", variants[variant], sizes[size], className)} {...props} />;`,
  "components/ui/badge.jsx": `import { cn } from "@/lib/utils";
const variants = { default: "bg-slate-900 text-white", secondary: "bg-slate-100 text-slate-900", outline: "border text-slate-900", destructive: "bg-red-600 text-white" };
export const Badge = ({ className, variant = "default", ...props }) => <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold", variants[variant], className)} {...props} />;`,
  "components/ui/input.jsx": `import { cn } from "@/lib/utils";
export const Input = ({ className, ...props }) => <input className={cn("flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm", className)} {...props} />;`,
  "components/ui/textarea.jsx": `import { cn } from "@/lib/utils";
export const Textarea = ({ className, ...props }) => <textarea className={cn("flex min-h-[80px] w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm", className)} {...props} />;`,
  "components/ui/label.jsx": `import { cn } from "@/lib/utils";
export const Label = ({ className, ...props }) => <label className={cn("text-sm font-medium leading-none", className)} {...props} />;`,
  "components/ui/separator.jsx": `import { cn } from "@/lib/utils";
export const Separator = ({ className, orientation = "horizontal", ...props }) => <div role="separator" className={cn("shrink-0 bg-slate-200", orientation === "horizontal" ? "h-px w-full" : "h-full w-px", className)} {...props} />;`,
  "components/ui/progress.jsx": `import { cn } from "@/lib/utils";
export const Progress = ({ className, value = 0, ...props }) => <div className={cn("relative h-4 w-full overflow-hidden rounded-full bg-slate-100", className)} {...props}><div className="h-full bg-slate-900 transition-all" style={{ width: (value || 0) + "%" }} /></div>;`,
  "components/ui/alert.jsx": `import { cn } from "@/lib/utils";
export const Alert = ({ className, variant = "default", ...props }) => <div role="alert" className={cn("relative w-full rounded-lg border p-4", variant === "destructive" ? "border-red-300 text-red-700" : "", className)} {...props} />;
export const AlertTitle = ({ className, ...props }) => <h5 className={cn("mb-1 font-medium leading-none tracking-tight", className)} {...props} />;
export const AlertDescription = ({ className, ...props }) => <div className={cn("text-sm", className)} {...props} />;`,
  "components/ui/tabs.jsx": `import { createContext, useContext, useState } from "react";
import { cn } from "@/lib/utils";
const TabsState = createContext(null);
export function Tabs({ defaultValue, value, onValueChange, className, children, ...props }) {
  const [own, setOwn] = useState(defaultValue);
  const current = value ?? own;
  const set = (next) => { setOwn(next); onValueChange?.(next); };
  return <TabsState.Provider value={{ current, set }}><div className={className} {...props}>{children}</div></TabsState.Provider>;
}
export const TabsList = ({ className, ...props }) => <div role="tablist" className={cn("inline-flex h-10 items-center justify-center rounded-md bg-slate-100 p-1 text-slate-500", className)} {...props} />;
export function TabsTrigger({ value, className, ...props }) {
  const state = useContext(TabsState);
  const active = state.current === value;
  return <button role="tab" aria-selected={active} onClick={() => state.set(value)} className={cn("inline-flex items-center justify-center rounded-sm px-3 py-1.5 text-sm font-medium", active ? "bg-white text-slate-950 shadow-sm" : "", className)} {...props} />;
}
export function TabsContent({ value, className, ...props }) {
  const state = useContext(TabsState);
  return state.current === value ? <div role="tabpanel" className={cn("mt-2", className)} {...props} /> : null;
}`,
};

async function buildComponent(source, work, entry) {
  const home = await toolchain();
  const src = join(work, "src");
  await cp(source, src, { recursive: true });
  for (const [path, text] of Object.entries(SHADCN)) {
    const target = join(src, path);
    if (existsSync(target)) continue;
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, text);
  }
  await symlink(join(home, "node_modules"), join(work, "node_modules"), "dir");
  await writeFile(join(work, "main.jsx"), `import { createRoot } from "react-dom/client";
import App from ${JSON.stringify(`./src/${entry}`)};
createRoot(document.getElementById("root")).render(<App />);
`);
  await writeFile(join(work, "tailwind.css"), "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n");
  const out = join(work, "dist");
  await mkdir(out, { recursive: true });
  const bin = join(home, "node_modules", ".bin");
  await run(join(bin, "esbuild"), ["main.jsx", "--bundle", "--minify", "--format=esm", "--jsx=automatic",
    "--loader:.js=jsx", `--alias:@=./src`, "--define:process.env.NODE_ENV=\"production\"", `--outfile=${join(out, "app.js")}`], { cwd: work });
  await run(join(bin, "tailwindcss"), ["-i", "tailwind.css", "-o", join(out, "styles.css"), "--minify",
    "--content", "./src/**/*.{js,jsx,ts,tsx}"], { cwd: work });
  const title = entry.replace(/\.[jt]sx?$/u, "").replace(/[-_]+/gu, " ");
  await writeFile(join(out, "index.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/[<&>"]/gu, "")}</title><link rel="stylesheet" href="styles.css"></head>
<body><div id="root"></div><script type="module" src="app.js"></script></body></html>
`);
  return out;
}

/** A project builds itself; its output is the first of the usual output folders holding an index.html. */
async function buildProject(source, work) {
  await cp(source, work, { recursive: true });
  const lock = existsSync(join(work, "package-lock.json"));
  await run("npm", [lock ? "ci" : "install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: work, failure: "canvas_build_install_failed" });
  await run("npm", ["run", "build"], { cwd: work });
  for (const candidate of ["dist", "build", "out"]) {
    if (existsSync(join(work, candidate, "index.html"))) return join(work, candidate);
  }
  throw new BuildRefusal("canvas_build_output_missing", "The build finished but left no dist, build or out folder with an index.html");
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain" };

/**
 * Open the built site as a person would and refuse it unless it renders: no
 * uncaught error, no failed request for one of its own files, and something
 * on the page. A site served from its own origin's root, as Rally serves it.
 */
async function check(out) {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const file = resolve(out, `.${path.endsWith("/") ? `${path}index.html` : path}`);
    if (!file.startsWith(out) || !existsSync(file) || !(await stat(file)).isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(await readFile(file));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let chromium;
  try {
    const globalRoot = (await new Promise((done) => {
      const child = spawn("npm", ["root", "-g"]);
      let text = "";
      child.stdout.on("data", (chunk) => { text += chunk; });
      child.on("exit", () => done(text.trim()));
    }));
    ({ chromium } = createRequire(join(globalRoot, "noop.js"))("playwright"));
  } catch {
    try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch {
      server.close();
      throw new BuildRefusal("canvas_build_check_unavailable", "Chromium is not available in this sandbox to check the site renders");
    }
  }
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(`error: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    page.on("response", (response) => {
      if (response.url().startsWith(origin) && response.status() >= 400) errors.push(`missing: ${new URL(response.url()).pathname}`);
    });
    await page.goto(`${origin}/`, { waitUntil: "networkidle", timeout: 20_000 });
    await page.waitForTimeout(500);
    // Runs in the page, where the document is the global one.
    const rendered = await page.evaluate(() => ({
      text: globalThis.document.body.innerText.trim().length,
      elements: globalThis.document.body.querySelectorAll("*").length,
    }));
    if (errors.length > 0) throw new BuildRefusal("canvas_build_check_failed", `The site does not run: ${errors.slice(0, 3).join("; ")}`);
    if (rendered.text === 0 && rendered.elements < 3) throw new BuildRefusal("canvas_build_check_empty", "The site loads but shows nothing");
    return rendered;
  } finally {
    await browser.close();
    server.close();
  }
}

try {
  const source = resolve(request.sourceDirectory);
  const work = resolve(request.workDirectory);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const out = request.kind === "component"
    ? await buildComponent(source, work, request.entry)
    : request.kind === "project"
      ? await buildProject(source, join(work, "project"))
      : (() => { throw new BuildRefusal("canvas_build_kind_unknown", `Nothing builds a ${request.kind}`); })();
  const rendered = await check(out);
  report({ ok: true, outputDirectory: out, files: await files(out), rendered });
} catch (error) {
  report({ ok: false, code: error instanceof BuildRefusal ? error.code : "canvas_build_failed",
    message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
