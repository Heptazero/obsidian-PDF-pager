import type { EpubLocation } from "./reading-state.ts";

export interface EpubPreferences {
  fontSize: number;
  lineHeight: number;
  paragraphGap: number;
  marginX: number;
  marginY: number;
  font: "original" | "serif" | "sans-serif";
  spread: "auto" | "single" | "double";
  columnGap: number;
}

export const DEFAULT_EPUB_PREFERENCES: EpubPreferences = {
  fontSize: 20, lineHeight: 1.65, paragraphGap: 0.4, marginX: 28, marginY: 24, font: "serif",
  spread: "auto", columnGap: 48,
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
    font: raw.font === "original" || raw.font === "sans-serif" ? raw.font : "serif",
    spread: raw.spread === "single" || raw.spread === "double" ? raw.spread : "auto",
    columnGap: number("columnGap", 16, 96),
  };
}

export function epubPageLayout(width: number, preferences: EpubPreferences): { columns: 1 | 2; gap: number; maxWidth: number } {
  const available = Math.max(1, width - 2 * Math.max(42, preferences.marginX));
  const minimum = Math.max(480, preferences.fontSize * 20 + preferences.columnGap * 2);
  const double = preferences.spread === "double" ? available >= minimum
    : preferences.spread === "auto" && available >= Math.max(900, minimum);
  return { columns: double ? 2 : 1, gap: double ? preferences.columnGap : 0,
    maxWidth: double ? 1440 : Math.min(900, preferences.fontSize * 36) };
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
