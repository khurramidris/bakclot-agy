import { describe, expect, it } from "vitest";

import {
  bytes,
  count,
  delta,
  duration,
  feedLabel,
  kindLabel,
  money,
  ms,
  pct,
  price,
  share,
  stageLabel,
} from "@/ops/format";
import { heatStep, HEAT_STEPS, FUNNEL_RAMP } from "@/ops/heat";
import { href, parseRoute } from "@/ops/route";

describe("ops dashboard: numbers in words", () => {
  it("writes money in full under $10K and compact above", () => {
    expect(money(1234.5)).toBe("$1,234.50");
    expect(money(12_900)).toBe("$12.9K");
    expect(money(12_900, false)).toBe("$12,900.00");
    expect(money(-20)).toBe("-$20.00");
    expect(money(null)).toBe("–");
    expect(money(Number.NaN)).toBe("–");
  });

  it("keeps fractions of a cent for per-second prices", () => {
    expect(price(0.0012)).toBe("$0.0012");
    expect(price(0.16)).toBe("$0.16");
    expect(price(null)).toBe("–");
  });

  it("counts, shares and compares", () => {
    expect(count(1284)).toBe("1,284");
    expect(count(12_900)).toBe("12.9K");
    expect(pct(42)).toBe("42%");
    expect(pct(null)).toBe("–");
    expect(share(1, 3)).toBe(33);
    expect(share(1, 0)).toBeNull();
    expect(delta(5, 3)).toBe("+2 vs yesterday");
    expect(delta(3, 5, "last week")).toBe("−2 vs last week");
    expect(delta(4, 4)).toBe("same as yesterday");
  });

  it("writes times the way people say them", () => {
    expect(ms(120)).toBe("120 ms");
    expect(ms(1234)).toBe("1.2 s");
    expect(ms(14_400)).toBe("14 s");
    expect(duration(45)).toBe("45 s");
    expect(duration(12 * 60)).toBe("12 min");
    expect(duration(3 * 3600 + 20 * 60)).toBe("3 h 20 min");
    expect(duration(52 * 3600)).toBe("2 d 4 h");
    expect(duration(null)).toBe("–");
    expect(bytes(999)).toBe("999 B");
    expect(bytes(12_345_678)).toBe("12 MB");
    expect(bytes(1_500_000_000)).toBe("1.4 GB");
    expect(bytes(10 * 1024 ** 3)).toBe("10 GB");
  });

  it("names stages, kinds and feed events in plain words", () => {
    expect(stageLabel("ready")).toBe("Your approval");
    expect(stageLabel("assembling")).toBe("Editing");
    expect(stageLabel("something_new")).toBe("something new");
    expect(kindLabel("microdrama")).toBe("Microdrama");
    expect(kindLabel("remix")).toBe("Video remix");
    expect(feedLabel("stage_failed")).toEqual({ label: "Video failed", tone: "bad" });
    expect(feedLabel("brand_new").label).toBe("brand new");
  });
});

describe("ops dashboard: pages in the URL", () => {
  it("reads the page and a customer id from the hash", () => {
    expect(parseRoute("")).toEqual({ page: "overview", id: null });
    expect(parseRoute("#/")).toEqual({ page: "overview", id: null });
    expect(parseRoute("#/live")).toEqual({ page: "live", id: null });
    expect(parseRoute("#/customers/abc-123")).toEqual({ page: "customers", id: "abc-123" });
    expect(parseRoute("#/nope")).toEqual({ page: "overview", id: null });
    expect(parseRoute("#/live/extra")).toEqual({ page: "live", id: null });
    expect(parseRoute("#/customers/%E0%A4%A")).toEqual({ page: "customers", id: null });
  });

  it("writes links that read back to the same page", () => {
    expect(href("overview")).toBe("#/");
    expect(href("backend")).toBe("#/backend");
    expect(parseRoute(href("customers", "a b"))).toEqual({ page: "customers", id: "a b" });
  });
});

describe("ops dashboard: the retention grid's colours", () => {
  it("bins percentages into one hue, more is lighter, 0% has no fill", () => {
    expect(heatStep(0)).toBeNull();
    expect(heatStep(5)?.label).toBe("1–9%");
    expect(heatStep(10)?.label).toBe("10–24%");
    expect(heatStep(49)?.label).toBe("25–49%");
    expect(heatStep(100)?.label).toBe("75–100%");
    expect(HEAT_STEPS.every((s) => s.fill.startsWith("var(--viz-blue-"))).toBe(true);
    expect(FUNNEL_RAMP).toHaveLength(5);
  });
});
