import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative asset URLs: the bundle runs from any static host and any sub-path (hash routing).
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      // Build the workspace client from source (its dist/ is not committed).
      "@outcry/client": fileURLToPath(new URL("../client/src/index.ts", import.meta.url)),
    },
  },
  define: {
    // web3.js / anchor expect these Node globals; Buffer is installed in src/polyfills.ts.
    "process.env": {},
    global: "globalThis",
  },
  optimizeDeps: {
    include: ["bs58", "buffer", "@coral-xyz/anchor", "@solana/web3.js", "@magicblock-labs/ephemeral-rollups-sdk", "tweetnacl"],
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2500,
  },
});
