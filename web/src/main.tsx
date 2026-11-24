// Brand fonts, bundled with the app (no font CDN): Inter for the interface, Inter Tight for headlines,
// Anton for the wordmark and title cards, Caveat for hand-written taglines.
import "@fontsource-variable/inter";
import "@fontsource-variable/inter-tight";
import "@fontsource/anton/400.css";
import "@fontsource/caveat/700.css";
import "./styles.css";

import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { setPublicConfig, type PublicConfig } from "@/lib/publicConfig";
import { initSupabase, setPublicPlan, type PublicPlan } from "@/lib/supabase";
import { getRouter } from "./router";

const root = createRoot(document.getElementById("root")!);

// Runtime config from the engine, so one build works in every environment.
fetch("/app-config.json")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`app config ${r.status}`))))
  .then(
    (
      cfg: {
        supabaseUrl: string;
        supabaseAnonKey: string;
        devUser?: string;
        plan?: PublicPlan;
      } & PublicConfig,
    ) => {
      initSupabase(cfg.supabaseUrl, cfg.supabaseAnonKey, cfg.devUser ?? null);
      setPublicPlan(cfg.plan);
      setPublicConfig(cfg);
      root.render(
        <StrictMode>
          <RouterProvider router={getRouter()} />
        </StrictMode>,
      );
    },
  )
  .catch((err: unknown) => {
    console.error(err);
    root.render(
      <p style={{ padding: 24, fontFamily: "sans-serif" }}>
        Backlot is starting up. Please refresh in a moment.
      </p>,
    );
  });
