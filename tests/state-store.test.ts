import assert from "node:assert/strict";
import { test } from "node:test";
import type { App } from "obsidian";
import { StateStore } from "../src/state-store.ts";

class MemoryAdapter {
  files = new Map<string, string>();
  folders = new Set<string>();
  async exists(path: string): Promise<boolean> { return this.files.has(path) || this.folders.has(path); }
  async mkdir(path: string): Promise<void> { this.folders.add(path); }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return { files: [...this.files.keys()].filter((file) => file.startsWith(path + "/")), folders: [] };
  }
  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error("missing file");
    return value;
  }
  async write(path: string, value: string): Promise<void> { this.files.set(path, value); }
  async remove(path: string): Promise<void> { this.files.delete(path); }
}

test("two devices keep independent files, merge bookmarks, and follow a PDF rename", async () => {
  const adapter = new MemoryAdapter();
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  const app = { vault: { getName: () => "test-vault", adapter } } as unknown as App;
  storage.set("pdf-pager-hz:device:test-vault", "device-aaaaaaaa");
  const first = new StateStore(app);
  await first.recordProgress("资料/论文.pdf", 10);
  const withFirstBookmark = await first.addBookmark("资料/论文.pdf", 4);
  const firstBookmark = withFirstBookmark.bookmarks[0];

  storage.set("pdf-pager-hz:device:test-vault", "device-bbbbbbbb");
  const second = new StateStore(app);
  assert.equal((await second.load("资料/论文.pdf")).progress?.page, 10);
  await second.addBookmark("资料/论文.pdf", 8);
  assert.equal((await first.load("资料/论文.pdf")).bookmarks.length, 2);
  await first.deleteBookmark("资料/论文.pdf", firstBookmark);
  assert.deepEqual((await second.load("资料/论文.pdf")).bookmarks.map((b) => b.page), [8]);
  assert.equal(adapter.files.size, 2);

  await first.rename("资料/论文.pdf", "资料/论文-新版.pdf");
  assert.equal((await second.load("资料/论文-新版.pdf")).progress?.page, 10);
  assert.deepEqual((await second.load("资料/论文-新版.pdf")).bookmarks.map((b) => b.page), [8]);
  assert.equal((await first.load("资料/论文.pdf")).bookmarks.length, 0);

  await first.renamePrefix("资料", "研究/资料");
  assert.equal((await second.load("研究/资料/论文-新版.pdf")).progress?.page, 10);
  assert.equal((await first.load("资料/论文-新版.pdf")).bookmarks.length, 0);
});
