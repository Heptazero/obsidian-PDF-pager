import assert from "node:assert/strict";
import { test } from "node:test";
import { epubPageLayout, normalizeEpubPreferences, validEpubLocation } from "../src/epub-state.ts";
import { aggregateReadingSessions, settlementLine, upsertDailySettlement } from "../src/reading-log.ts";
import { ReadingTracker } from "../src/reading-tracker.ts";
import type { ReadingSession } from "../src/reading-state.ts";

test("EPUB preferences reject corrupt numbers and clamp mobile layout limits", () => {
  const preferences = normalizeEpubPreferences({ fontSize: Infinity, marginX: -1, marginY: 999, font: "invalid" });
  assert.equal(preferences.fontSize, 20);
  assert.equal(preferences.marginX, 0);
  assert.equal(preferences.marginTop, 64);
  assert.equal(preferences.marginBottom, 64);
  assert.equal(normalizeEpubPreferences({ marginY: 24, marginTop: 8, marginBottom: 0 }).marginBottom, 0);
  assert.equal(normalizeEpubPreferences({ marginY: 24, marginTop: 8 }).marginTop, 8);
  assert.equal(normalizeEpubPreferences({ marginY: 24, marginTop: 8 }).marginBottom, 24);
  assert.equal(preferences.font, "serif");
  assert.equal(validEpubLocation({ cfi: "epubcfi(/6/2!/4/2/1:0)", percentage: NaN, chapter: "A" }), false);
});

test("book layout adapts to width while preserving explicit layout and existing font choices", () => {
  const preferences = normalizeEpubPreferences({ font: "original", fontSize: 20 });
  assert.equal(preferences.font, "original");
  assert.equal(epubPageLayout(1440, preferences).columns, 2);
  assert.equal(epubPageLayout(844, preferences).columns, 1);
  assert.equal(epubPageLayout(844, { ...preferences, spread: "double" }).columns, 2);
  assert.equal(epubPageLayout(390, { ...preferences, spread: "double" }).columns, 1);
  assert.equal(epubPageLayout(1440, { ...preferences, spread: "single" }).maxWidth, 720);
  assert.equal(epubPageLayout(1440, { ...preferences, columnGap: 80 }).gap, 80);
});

test("EPUB tracker stops at idle, resumes as a new session, and pauses in the background", async () => {
  let now = new Date(2026, 10, 2, 12).getTime();
  let active = true;
  let id = 0;
  const saved = new Map<string, ReadingSession>();
  const tracker = new ReadingTracker(() => active, () => ({ idleMs: 25_000, dayEndMinutes: 0 }),
    async (session) => { saved.set(session.id, session); }, () => now, () => `session-${++id}`);
  tracker.setLocation({ cfi: "epubcfi(/6/2!/4/2/1:0)", percentage: 0.1, chapter: "一" });
  tracker.activity();
  now += 10_000; tracker.tick();
  tracker.setLocation({ cfi: "epubcfi(/6/2!/4/2/1:500)", percentage: 0.2, chapter: "一" });
  now += 10_000; tracker.tick();
  now += 10_000; tracker.tick();
  await tracker.flush();
  assert.equal(saved.get("session-1")?.durationMs, 25_000);
  assert.equal(saved.get("session-1")?.startLocation?.percentage, 0.1);
  assert.equal(saved.get("session-1")?.endLocation?.percentage, 0.2);
  now += 100_000; tracker.tick();
  tracker.activity();
  now += 8_000; active = false; tracker.pause();
  now += 100_000; await tracker.flush();
  assert.equal(saved.get("session-2")?.durationMs, 8_000);
});

test("EPUB reading splits at a configured day boundary", async () => {
  let now = new Date(2026, 10, 3, 3, 59, 50).getTime();
  let id = 0;
  const saved = new Map<string, ReadingSession>();
  const tracker = new ReadingTracker(() => true, () => ({ idleMs: 60_000, dayEndMinutes: 240 }),
    async (session) => { saved.set(session.id, session); }, () => now, () => `split-${++id}`);
  tracker.setLocation({ cfi: "epubcfi(/6/2!/4/2/1:0)", percentage: 0.3, chapter: "二" });
  tracker.activity();
  now += 20_000;
  await tracker.flush();
  assert.equal(saved.get("split-1")?.day, "2026-11-02");
  assert.equal(saved.get("split-1")?.durationMs, 10_000);
  assert.equal(saved.get("split-2")?.day, "2026-11-03");
  assert.equal(saved.get("split-2")?.durationMs, 10_000);
});

test("EPUB logs settle percentages instead of reflowed screen numbers and update in place", () => {
  const session: ReadingSession = {
    id: "s", day: "2026-11-02", startedAt: 10, endedAt: 600010, durationMs: 600000,
    startPage: 1, endPage: 1, minPage: 1, maxPage: 1, updatedAt: 600010,
    startLocation: { cfi: "epubcfi(/6/2!/4/2/1:0)", percentage: 0.1, chapter: "一" },
    endLocation: { cfi: "epubcfi(/6/2!/4/2/1:500)", percentage: 0.2, chapter: "二" },
  };
  const summary = aggregateReadingSessions([{ ...session, pdfPath: "书.epub", deviceId: "d" }])[0];
  assert.match(settlementLine(summary), /\[EPUB 10.0%–20.0%\]/);
  const first = upsertDailySettlement("## log\n", summary).content + "\n  感想原文\n";
  summary.durationMs *= 2;
  const second = upsertDailySettlement(first, summary).content;
  assert.equal(second.split("<!-- pdf-pager:").length, 2);
  assert.ok(second.includes("感想原文"));
  assert.notEqual(first, second);
});
