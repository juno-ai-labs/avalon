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
