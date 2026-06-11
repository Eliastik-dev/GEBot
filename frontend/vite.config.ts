import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

export default defineConfig(({ mode }) => ({
  plugins: [react(), cssInjectedByJsPlugin()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: mode !== "production",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: "src/widget-entry.tsx",
      output: {
        format: "iife",
        entryFileNames: "gebot-widget.js",
        assetFileNames: "gebot-widget.[ext]",
        inlineDynamicImports: true,
      },
    },
  },
}));

