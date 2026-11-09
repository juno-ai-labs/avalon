import { readFile } from "node:fs/promises";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      // A `.md` import is the file's text, as the Worker's `rules` (Text
      // modules) in `wrangler.jsonc` make it: the plugin's skills.
      name: "rally:text-modules",
      enforce: "pre",
      async load(id) {
        const path = id.split("?")[0]!;
        if (!path.endsWith(".md")) return null;
        return { code: `export default ${JSON.stringify(await readFile(path, "utf8"))};`, map: null };
      },
    },
  ],
  test: {
    environment: "node",
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
