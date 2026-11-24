// The dashboard's pages live in the URL hash (#/live, #/customers/<id>), so links and the back button work and the ops
// server only ever serves one page.
import { useEffect, useState } from "react";

export const PAGES = [
  "overview",
  "live",
  "business",
  "customers",
  "product",
  "backend",
  "providers",
  "safety",
] as const;
export type Page = (typeof PAGES)[number];
export type Route = { page: Page; id: string | null };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const first = parts[0] ?? "";
  const page = (PAGES as readonly string[]).includes(first) ? (first as Page) : "overview";
  let id: string | null = null;
  if (page === "customers" && parts[1]) {
    try {
      id = decodeURIComponent(parts[1]);
    } catch {
      id = null;
    }
  }
  return { page, id };
}

export const href = (page: Page | string, id?: string | null) =>
  page === "overview" && !id ? "#/" : `#/${page}${id ? `/${encodeURIComponent(id)}` : ""}`;

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
