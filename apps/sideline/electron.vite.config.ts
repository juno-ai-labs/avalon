import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const marker = "__SIDELINE_DEVELOPMENT_SCRIPT_SOURCE__";

export default defineConfig({
  main: {
    define: {
      "process.env.SIDELINE_RELEASE_BUILD": JSON.stringify(process.env.SIDELINE_RELEASE_BUILD ?? ""),
      // Read in src/main/index.ts: the updater prompts once a build is stale.
      __SIDELINE_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    plugins: [externalizeDepsPlugin({ exclude: ["@rally/contracts", "@rally/electron-network"] })],
  },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } } },
  renderer: {
    plugins: [{
      name: "sideline-csp",
      transformIndexHtml: {
        order: "pre",
        handler(html, context) {
          if (!html.includes(marker)) throw new Error("Sideline renderer CSP marker is missing");
          if (!context.server) return html.replace(marker, "");
          return html
            .replace(marker, "'unsafe-inline'")
            .replace("connect-src 'none'", "connect-src 'self' ws: wss:");
        },
      },
    }, react()],
  },
});
