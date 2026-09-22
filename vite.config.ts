import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": "/src/frontend",
    },
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    rollupOptions: {
      input: "src/frontend/main.tsx",
      output: {
        entryFileNames: "suplex-ui.js",
        chunkFileNames: "[name]-[hash].js",
        assetFileNames: "suplex-ui.[ext]",
      },
    },
  },
});
