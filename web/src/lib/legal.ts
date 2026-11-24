/**
 * The legal entity behind Backlot, where it's registered, and how to reach it. Set on the engine (LEGAL_COMPANY,
 * LEGAL_JURISDICTION, LEGAL_ADDRESS, SUPPORT_EMAIL) and read at startup from /app-config.json, so no rebuild is needed.
 * The bracketed placeholders show until they are set, and the Setup check flags them.
 */
export const LEGAL = {
  company: "[Company legal name]",
  jurisdiction: "[Country / state]",
  address: "[Registered address]",
  email: "[support@your-domain]",
  updated: "14 November 2026",
};

export function setLegal(v: Partial<typeof LEGAL> | undefined) {
  if (!v) return;
  for (const k of Object.keys(LEGAL) as (keyof typeof LEGAL)[]) if (v[k]) LEGAL[k] = String(v[k]);
}

/** A mailto link for support, or null while no address is set. */
export const supportHref = () =>
  LEGAL.email.includes("@") && !LEGAL.email.startsWith("[") ? `mailto:${LEGAL.email}` : null;
