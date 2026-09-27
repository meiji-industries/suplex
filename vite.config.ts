import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ command }) => ({
  // The native host serves the build under /assets/; Vite dev serves from its own root.
  base: command === "build" ? "/assets/" : "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": "/src/frontend",
    },
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: "src/frontend/main.tsx",
      output: {
        entryFileNames: "suplex-ui.js",
        chunkFileNames: "[name]-[hash].js",
        assetFileNames: "suplex-ui.[ext]",
      },
    },
  },
}));
