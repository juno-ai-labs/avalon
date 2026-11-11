/**
 * A `.py` or `.sandbox.mjs` import is the file's text: a script Rally ships
 * into a sandbox rather than runs itself. The Worker bundles get this from the
 * `rules` (Text modules) in `wrangler.global.jsonc` and `wrangler.test.jsonc`;
 * the Node test run gets it from the `rally:text-modules` plugin in
 * `vitest.config.ts`. Both hand back the file's UTF-8 content unchanged.
 */
declare module "*.py" {
  const text: string;
  export default text;
}

declare module "*.sandbox.mjs" {
  const text: string;
  export default text;
}

/**
 * Every file of a Canvas seed's site (`canvas-seeds/<seed>/site/`) is text the
 * Worker publishes, never code it runs: the same Text rule and the same
 * plugin hand it back unchanged. Each name a seed imports is declared here,
 * because a `.js` file would otherwise be read as a module.
 */
declare module "*/site/index.js" {
  const text: string;
  export default text;
}

declare module "*/site/app.js" {
  const text: string;
  export default text;
}

declare module "*/site/index.html" {
  const text: string;
  export default text;
}

declare module "*/site/styles.css" {
  const text: string;
  export default text;
}

declare module "*/site/README.md" {
  const text: string;
  export default text;
}
