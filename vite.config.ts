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
        entryFileNames: "forge-ui.js",
        assetFileNames: "forge-ui.[ext]",
      },
    },
  },
});
