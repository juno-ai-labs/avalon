import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import desktopTheme from "../desktop/tailwind.config";
export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  css: { postcss: { plugins: [tailwindcss({ ...desktopTheme,
    content: [fileURLToPath(new URL("./src/**/*.{html,ts,tsx}", import.meta.url)), fileURLToPath(new URL("../../packages/ui/src/**/*.{ts,tsx}", import.meta.url)), fileURLToPath(new URL("../desktop/src/renderer/**/*.{html,ts,tsx}", import.meta.url))],
  }), autoprefixer()] } },
});
