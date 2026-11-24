// The retention grid's colour bins: one hue (blue), more is lighter on the dark card. Text on each fill is the one
// that reads best there (ivory on the two dark steps, cinema black on the light ones: all at least 6.5:1).
export const HEAT_STEPS = [
  { min: 1, label: "1–9%", fill: "var(--viz-blue-650)", ink: "var(--ivory)" },
  { min: 10, label: "10–24%", fill: "var(--viz-blue-550)", ink: "var(--ivory)" },
  { min: 25, label: "25–49%", fill: "var(--viz-blue-350)", ink: "var(--cinema)" },
  { min: 50, label: "50–74%", fill: "var(--viz-blue-250)", ink: "var(--cinema)" },
  { min: 75, label: "75–100%", fill: "var(--viz-blue-150)", ink: "var(--cinema)" },
];

/** The bin for a percentage, or null for 0% (no fill: the cell reads as empty). */
export function heatStep(pct: number) {
  let step: (typeof HEAT_STEPS)[number] | null = null;
  for (const s of HEAT_STEPS) if (pct >= s.min) step = s;
  return step;
}

/** Funnel steps in order, light to dark (the ordinal ramp, checked for contrast on the card). */
export const FUNNEL_RAMP = [
  "var(--viz-blue-200)",
  "var(--viz-blue-300)",
  "var(--viz-blue-400)",
  "var(--viz-blue-500)",
  "var(--viz-blue-600)",
];
