/** A `.md` import is the file's text (`rules` in `wrangler.jsonc`, the plugin in `vitest.config.ts`). */
declare module "*.md" {
  const text: string;
  export default text;
}
