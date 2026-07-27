import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      output: {
        // maplibre-gl and the deck.gl family are the bulk of bundle size
        // and change far less often than our own app code. Splitting them
        // into their own chunks means a deploy that only touches
        // src/*.ts doesn't force browsers to redownload ~1.5MB of vendor
        // code they already have cached -- only the small app chunk
        // changes.
        //
        // This does NOT make Vite's "chunk larger than 500kB" warning go
        // away -- maplibre-gl alone is ~970kB minified, deck.gl ~600kB,
        // each now its own chunk and each still over the threshold on its
        // own. That's an unavoidable cost of what these libraries do
        // (WebGL vector map rendering, GPU-accelerated overlays); there's
        // nothing to "fix" here short of not using them. chunkSizeWarningLimit
        // below raises the threshold past both, so the warning is only
        // raised again if something unexpected bloats the bundle further.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("maplibre-gl")) return "vendor-maplibre";
          if (/[\\/]@deck\.gl[\\/]|[\\/]@luma\.gl[\\/]|[\\/]@math\.gl[\\/]|[\\/]@loaders\.gl[\\/]|[\\/]mjolnir\.js[\\/]/.test(id)) {
            return "vendor-deckgl";
          }
          return "vendor";
        },
      },
    },
    chunkSizeWarningLimit: 1100,
  },
  server: {
    // Convenient for `npm run dev` against a locally running api container
    // (docker compose up api) without needing CORS gymnastics.
    proxy: {
      "/api": "http://localhost:8000",
      "/ws": {
        target: "ws://localhost:8000",
        ws: true,
      },
    },
  },
});
