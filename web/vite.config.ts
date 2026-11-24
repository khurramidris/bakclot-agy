import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the engine runs on :8787 and the ops dashboard's server on :8790; in production the engine serves
// this app itself, and the ops service serves ops/index.html (the dashboard) on its own address.
const engine = process.env["ENGINE_URL"] ?? "http://localhost:8787";
const ops = process.env["OPS_URL"] ?? "http://localhost:8790";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: { tsconfigPaths: true },
  build: {
    // Two pages: the app (index.html) and the ops dashboard (ops/index.html, open /ops/ in development).
    rolldownOptions: { input: { main: "index.html", ops: "ops/index.html" } },
  },
  server: {
    port: 5173,
    proxy: {
      ...Object.fromEntries(
        ["/v1", "/files", "/webhooks", "/app-config.json"].map((p) => [p, engine]),
      ),
      "/api": ops,
    },
  },
});
