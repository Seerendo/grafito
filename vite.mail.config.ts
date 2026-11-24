import { defineConfig } from "vite";

/**
 * Build of the mail-sync worker (src/mail-worker/main.ts) into .output-mail/main.mjs, with its
 * dependencies inside so the runtime image needs no node_modules. Same aliases as the app.
 * `npm run build` runs it after the app's build.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  // The worker reads the database URL and secrets at runtime, never at build time.
  envPrefix: "GRAFITO_BUILD_",
  publicDir: false,
  build: {
    ssr: "src/mail-worker/main.ts",
    outDir: ".output-mail",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: { format: "es", entryFileNames: "main.mjs", inlineDynamicImports: true },
    },
  },
  ssr: { noExternal: true, target: "node" },
});
