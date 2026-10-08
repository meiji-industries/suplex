import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ command }) => ({
  // The native host serves the build under /assets/; Vite dev serves from its own root.
  base: command === "build" ? "/assets/" : "/",
  plugins: [react(), tailwindcss()],
  // Local data holds task and move worktrees, and Cargo writes build output under target/; neither may trigger a full reload.
  server: { watch: { ignored: ["**/.suplex/**", "**/target/**"] } },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: "main.tsx",
      output: {
        entryFileNames: "suplex-ui.js",
        chunkFileNames: "[name]-[hash].js",
        // Only the CSS entry keeps a fixed name; fonts get hashed names because the server caches them as immutable.
        assetFileNames: (asset) => (asset.names.some((name) => name.endsWith(".css")) ? "suplex-ui.[ext]" : "[name]-[hash].[ext]"),
      },
    },
  },
}));
