import type { EpubLocation } from "./reading-state.ts";

export interface EpubPreferences {
  fontSize: number;
  lineHeight: number;
  paragraphGap: number;
  marginX: number;
  marginY: number;
  font: "original" | "serif" | "sans-serif";
}

export const DEFAULT_EPUB_PREFERENCES: EpubPreferences = {
  fontSize: 20, lineHeight: 1.7, paragraphGap: 0.6, marginX: 16, marginY: 12, font: "original",
};

export function normalizeEpubPreferences(value: unknown): EpubPreferences {
  const raw = value && typeof value === "object" ? value as Partial<EpubPreferences> : {};
  const number = (key: keyof EpubPreferences, min: number, max: number) => {
    const candidate = raw[key];
    return typeof candidate === "number" && Number.isFinite(candidate)
      ? Math.max(min, Math.min(max, candidate)) : DEFAULT_EPUB_PREFERENCES[key] as number;
  };
  return {
    fontSize: number("fontSize", 12, 40), lineHeight: number("lineHeight", 1.1, 2.5),
    paragraphGap: number("paragraphGap", 0, 2), marginX: number("marginX", 0, 64), marginY: number("marginY", 0, 64),
    font: raw.font === "serif" || raw.font === "sans-serif" ? raw.font : "original",
  };
}

export function validEpubLocation(value: unknown): value is EpubLocation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EpubLocation>;
  return typeof candidate.cfi === "string" && candidate.cfi.startsWith("epubcfi(") && candidate.cfi.endsWith(")")
    && typeof candidate.percentage === "number" && Number.isFinite(candidate.percentage)
    && candidate.percentage >= 0 && candidate.percentage <= 1 && typeof candidate.chapter === "string";
}

export function epubRange(start?: EpubLocation, end?: EpubLocation): string {
  if (!start || !end) return "EPUB";
  const from = (start.percentage * 100).toFixed(1);
  const to = (end.percentage * 100).toFixed(1);
  return from === to ? `EPUB ${from}%` : `EPUB ${from}%–${to}%`;
}
