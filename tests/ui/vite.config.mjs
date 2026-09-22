import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../..");

/**
 * Builds only the Backstage sheet harness. It is deliberately separate from the
 * Worker build (`npm run build`) so nothing here can reach production.
 */
export default defineConfig({
  root: here,
  // Serves the real fonts and images, so the harness renders in the actual
  // typeface rather than a fallback.
  publicDir: path.resolve(projectRoot, "public"),
  plugins: [
    react(),
    {
      name: "harness-plain-css",
      enforce: "pre",
      /**
       * `app/globals.css` opens with Tailwind and the vendored shadcn theme.
       * No Backstage component uses either, and processing them costs seconds
       * per run, so the harness takes the design layer alone.
       */
      transform(code, id) {
        if (!id.split("?")[0].endsWith(path.join("app", "globals.css"))) return null;
        return { code: code.replace(/^@import[^\n]*\n/gm, ""), map: null };
      },
    },
  ],
  // An empty object stops Vite loading the project's postcss.config.mjs, which
  // would pull Tailwind back in.
  css: { postcss: {} },
  resolve: {
    alias: [
      { find: /^next\/link$/, replacement: path.join(here, "stubs/next-link.tsx") },
      { find: /^next\/navigation$/, replacement: path.join(here, "stubs/next-navigation.ts") },
      { find: /^@\//, replacement: `${projectRoot}/` },
    ],
  },
});
