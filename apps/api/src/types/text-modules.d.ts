/**
 * A `.py` import is the file's text. The Worker bundles get this from the
 * `rules` (Text modules) in `wrangler.global.jsonc` and `wrangler.test.jsonc`;
 * the Node test run gets it from the `rally:text-modules` plugin in
 * `vitest.config.ts`. Both hand back the file's UTF-8 content unchanged.
 */
declare module "*.py" {
  const text: string;
  export default text;
}
