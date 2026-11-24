// Settings the engine publishes at /app-config.json (no sign-in needed), read once at startup so one build works in
// every environment: the public API's address and limits, and the headline prices for public pages.
import { setLegal } from "@/lib/legal";

export const API_INFO = {
  enabled: false,
  base_url: "",
  retention_days: 7,
  clip_seconds: [5, 15] as [number, number],
  film_max_seconds: 900,
  requests_per_minute: 300,
  creates_per_minute: 30,
  max_active: 20,
  max_active_films: 3,
};

export const PRICES = { per_second_usd: 0.16, setup_fee_usd: 2 };

export type PublicConfig = {
  api?: Partial<typeof API_INFO>;
  prices?: Partial<typeof PRICES>;
  legal?: Record<string, string>;
};

export function setPublicConfig(cfg: PublicConfig) {
  if (cfg.api) Object.assign(API_INFO, cfg.api);
  if (cfg.prices) Object.assign(PRICES, cfg.prices);
  setLegal(cfg.legal);
  // Same origin in production: if the engine doesn't know its public address, use the one the browser sees.
  if (!API_INFO.base_url || API_INFO.base_url === "/api/v1")
    API_INFO.base_url = `${window.location.origin}/api/v1`;
}
