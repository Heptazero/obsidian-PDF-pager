import assert from "node:assert/strict";
import { test } from "node:test";
import { clampPage, mergeRecords, pathKey, shouldRecordPage, type DeviceRecord } from "../src/reading-state.ts";

test("inactive and restored pages never overwrite a reading session", () => {
  assert.equal(shouldRecordPage(false, false, true, 3, 2), false);
  assert.equal(shouldRecordPage(true, true, true, 3, 2), false);
  assert.equal(shouldRecordPage(true, false, false, 3, 2), false);
  assert.equal(shouldRecordPage(true, false, true, 2, 2), false);
  assert.equal(shouldRecordPage(true, false, true, 3, 2), true);
});

test("progress comes from latest actual read and bookmark deletion wins", () => {
  const a: DeviceRecord = {
    version: 1, pdfPath: "a.pdf", deviceId: "a", progress: { page: 10, updatedAt: 100 },
    bookmarks: { x: { id: "x", page: 4, label: "第 4 页", updatedAt: 90 } },
  };
  const b: DeviceRecord = {
    version: 1, pdfPath: "a.pdf", deviceId: "b", progress: { page: 8, updatedAt: 200 },
    bookmarks: {
      x: { id: "x", page: 4, label: "第 4 页", updatedAt: 120, deleted: true },
      y: { id: "y", page: 9, label: "第 9 页", updatedAt: 130 },
    },
  };
  assert.deepEqual(mergeRecords([a, b]), { progress: { page: 8, updatedAt: 200 }, bookmarks: [b.bookmarks.y] });
});

test("path hash normalizes macOS filenames and page stays in range", () => {
  assert.equal(pathKey("论文/e\u0301.pdf"), pathKey("论文/é.pdf"));
  assert.equal(clampPage(999, 25), 25);
  assert.equal(clampPage(0, 25), 1);
});
