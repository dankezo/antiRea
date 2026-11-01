/** Configuration EXAMPLE: merge into existing vite.config.ts, not a dependency of the SDK. */
import { defineConfig } from "vite";
export default defineConfig({
  esbuild: {
    drop: ["console", "debugger"],
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        chunkFileNames: "assets/chunk-[hash].js",
        entryFileNames: "assets/index-[hash].js",
      },
    },
  },
});
