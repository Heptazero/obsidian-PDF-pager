import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateReadingSessions, formatHourToken, settlementMarker, upsertDailySettlement, weekDays,
  type BookDaySummary,
} from "../src/reading-log.ts";
import type { StoredReadingSession } from "../src/state-store.ts";

function session(overrides: Partial<StoredReadingSession> = {}): StoredReadingSession {
  return {
    id: "session-1",
    day: "2026-10-08",
    pdfPath: "30_resource/book/书.pdf",
    deviceId: "phone",
    startedAt: 100,
    endedAt: 200,
    durationMs: 30 * 60_000,
    startPage: 20,
    endPage: 29,
    minPage: 20,
    maxPage: 29,
    updatedAt: 200,
    ...overrides,
  };
}

test("sessions from multiple devices aggregate by book and local day", () => {
  const summaries = aggregateReadingSessions([
    session(),
    session({ id: "session-2", deviceId: "tablet", startedAt: 300, endedAt: 400, durationMs: 48 * 60_000, startPage: 30, endPage: 43, minPage: 30, maxPage: 43 }),
    session({ id: "session-3", day: "2026-10-07", durationMs: 10 * 60_000 }),
  ]);
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].day, "2026-10-08");
  assert.equal(summaries[0].durationMs, 78 * 60_000);
  assert.equal(summaries[0].startPage, 20);
  assert.equal(summaries[0].endPage, 43);
  assert.equal(formatHourToken(summaries[0].durationMs), "1.3h");
});

test("settlement creates one managed row and later settlement replaces it", () => {
  const first = aggregateReadingSessions([session()])[0];
  const created = upsertDailySettlement("---\ntype: book\n---\n\n正文", first);
  assert.match(created.content, /## log\n\n- 1008 \[20-29\] \[0\.5h\]/);
  const updatedSummary: BookDaySummary = { ...first, durationMs: 78 * 60_000, endPage: 43 };
  const updated = upsertDailySettlement(created.content + "\n\t- 我的感想", updatedSummary);
  assert.equal(updated.content.match(new RegExp(settlementMarker(first.day, first.pdfPath), "g"))?.length, 1);
  assert.match(updated.content, /- 1008 \[20-43\] \[1\.3h\]/);
  assert.match(updated.content, /\t- 我的感想/);
});

test("settlement adopts an existing manual day row without double-counting", () => {
  const summary = aggregateReadingSessions([session()])[0];
  const source = "## log\n\n- 1008 [15-20] [0.2h] 手动备注\n\t- 感想";
  const updated = upsertDailySettlement(source, summary);
  assert.match(updated.content, /- 1008 \[20-29\] \[0\.5h\].*手动备注/);
  assert.equal(updated.content.match(/\[[\d.]+h\]/g)?.length, 1);
  assert.match(updated.content, /\t- 感想/);
});

test("week view starts on Monday", () => {
  assert.deepEqual(weekDays("2026-10-08"), [
    "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11",
  ]);
});
