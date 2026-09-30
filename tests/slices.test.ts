import assert from "node:assert/strict";
import { test } from "node:test";
import { clampPosition, positionFromScroll, scrollTopForPosition, sliceCount, sliceIndexAtOffset, sliceOffset, slicePosition } from "../src/slices.ts";
import { shouldRecordLocation } from "../src/reading-state.ts";

test("landscape screens divide a tall page into ordered stops", () => {
  assert.equal(sliceCount(1080, 400, true), 3);
  assert.equal(sliceCount(1080, 400, false), 1);
  assert.equal(sliceOffset(0, 1080, 400, 3), 0);
  assert.equal(sliceOffset(1, 1080, 400, 3), 400);
  assert.equal(sliceOffset(2, 1080, 400, 3), 680);
  assert.equal(slicePosition(1, 1080, 400, 3), 400 / 680);
  assert.equal(sliceIndexAtOffset(400, 1080, 400, 3), 1);
  assert.equal(scrollTopForPosition(12, 1080, 400, slicePosition(1, 1080, 400, 3), 900), 412);
  assert.equal(positionFromScroll(412, 12, 1080, 400), 400 / 680);
});

test("rotation and old records preserve a bounded reading location", () => {
  assert.equal(clampPosition(undefined), 0);
  assert.equal(clampPosition(3), 1);
  assert.equal(shouldRecordLocation(true, false, true, 4, 4, 0.5, 0), true);
  assert.equal(shouldRecordLocation(false, false, true, 4, 4, 0.5, 0), false);
  assert.equal(shouldRecordLocation(true, true, true, 4, 4, 0.5, 0), false);
});
