import assert from "node:assert/strict";
import { test } from "node:test";
import { centeredScrollLeft, relativeZoom, scaleForNewFloor } from "../src/zoom.ts";

test("width floor changes keep pinch enlargement and let an unzoomed page shrink", () => {
  assert.equal(scaleForNewFloor(1.4, 1.4, 1.1), 1.1);
  assert.equal(scaleForNewFloor(2, 1.4, 1.1), 2);
  assert.equal(scaleForNewFloor(2, 1.4, 2.2), 2.2);
  assert.equal(scaleForNewFloor(0.9, 1.1, 1.2), 1.2);
});

test("orientation reflow retains pinch factor above the recomputed floor", () => {
  assert.equal(relativeZoom(2.4, 1.2), 2);
  assert.equal(relativeZoom(0.9, 1.2), 1);
});

test("page centering clears inherited horizontal pan within scroll bounds", () => {
  assert.equal(centeredScrollLeft(90, 400, -90, 800), 0);
  assert.equal(centeredScrollLeft(180, 400, 120, 800), 300);
  assert.equal(centeredScrollLeft(180, 400, 900, 800), 400);
});
