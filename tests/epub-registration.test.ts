import assert from "node:assert/strict";
import { test } from "node:test";
import type { App } from "obsidian";
import { ensureEpubRegistration } from "../src/epub-registration.ts";

test("EPUB visibility recovers when an earlier reader is disabled without replacing active readers", () => {
  let owner: string | undefined = "old-reader";
  let writes = 0;
  const app = { viewRegistry: { getTypeByExtension: () => owner } } as unknown as App;
  const repair = () => ensureEpubRegistration(app, "pdf-pager-epub", () => { owner = "pdf-pager-epub"; writes++; });
  assert.equal(repair(), "other-reader");
  assert.equal(writes, 0);
  owner = undefined;
  assert.equal(repair(), "registered");
  assert.equal(owner, "pdf-pager-epub");
  assert.equal(writes, 1);
  assert.equal(repair(), "ready");
  assert.equal(writes, 1, "layout events must not repeatedly register an existing handler");
});

test("EPUB repair tolerates an unavailable internal lookup and reports registration failures", () => {
  assert.equal(ensureEpubRegistration({} as App, "reader", () => assert.fail("must not register blindly")), "unavailable");
  const app = { viewRegistry: { getTypeByExtension: () => undefined } } as unknown as App;
  assert.throws(() => ensureEpubRegistration(app, "reader", () => { throw Error("cannot register"); }), /cannot register/);
});
