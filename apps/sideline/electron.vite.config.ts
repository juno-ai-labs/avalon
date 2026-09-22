import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const marker = "__SIDELINE_DEVELOPMENT_SCRIPT_SOURCE__";

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin({ exclude: ["@rally/contracts"] })] },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } } },
  renderer: {
    plugins: [{
      name: "sideline-csp",
      transformIndexHtml: {
        order: "pre",
        handler(html, context) {
          if (!html.includes(marker)) throw new Error("Sideline renderer CSP marker is missing");
          return html.replace(marker, context.server ? "'unsafe-inline'" : "");
        },
      },
    }, react()],
  },
});
