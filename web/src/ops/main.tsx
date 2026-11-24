// The ops dashboard (web/ops/index.html): a separate page and service from the app, for admins only.
import "@fontsource-variable/inter";
import "@fontsource-variable/inter-tight";
import "@fontsource/anton/400.css";
import "../styles.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { initSupabase } from "@/lib/supabase";

import { OpsApp } from "./App";

const root = createRoot(document.getElementById("root")!);
const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 5_000 } },
});

// Sign-in settings come from the dashboard's server (the same Supabase project as the app).
fetch("/app-config.json")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`app config ${r.status}`))))
  .then((cfg: { supabaseUrl: string; supabaseAnonKey: string; devUser?: string }) => {
    initSupabase(cfg.supabaseUrl, cfg.supabaseAnonKey, cfg.devUser ?? null);
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <OpsApp />
        </QueryClientProvider>
      </StrictMode>,
    );
  })
  .catch((err: unknown) => {
    console.error(err);
    root.render(
      <p style={{ padding: 24, fontFamily: "sans-serif" }}>
        The dashboard’s server isn’t answering. Refresh in a moment.
      </p>,
    );
  });
