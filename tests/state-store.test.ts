import assert from "node:assert/strict";
import { test } from "node:test";
import type { App } from "obsidian";
import { pathKey } from "../src/reading-state.ts";
import { recordFileName, StateStore } from "../src/state-store.ts";

class MemoryAdapter {
  files = new Map<string, string>();
  folders = new Set<string>();
  failWritePrefix?: string;
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
  async write(path: string, value: string): Promise<void> {
    if (this.failWritePrefix && path.startsWith(this.failWritePrefix)) throw new Error("write failed");
    this.files.set(path, value);
  }
  async remove(path: string): Promise<void> { this.files.delete(path); }
}

function memoryApp(adapter: MemoryAdapter, storage: Map<string, unknown>): App {
  return {
    vault: { getName: () => "test-vault", configDir: ".obsidian", adapter },
    loadLocalStorage: (key: string) => storage.get(key) ?? null,
    saveLocalStorage: (key: string, value: unknown) => storage.set(key, value),
  } as unknown as App;
}

test("two devices keep independent files, merge bookmarks, and follow a PDF rename", async () => {
  const adapter = new MemoryAdapter();
  const storage = new Map<string, unknown>();
  const app = memoryApp(adapter, storage);
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

test("legacy vault records are loaded and copied into the plugin config folder", async () => {
  const adapter = new MemoryAdapter();
  const storage = new Map<string, unknown>();
  const path = "资料/旧论文.pdf";
  const device = "device-aaaaaaaa";
  const legacyRoot = "99_assets/plugin-data/pdf-pager";
  adapter.folders.add(legacyRoot);
  adapter.files.set(`${legacyRoot}/${pathKey(path)}-${device}.json`, JSON.stringify({
    version: 1,
    pdfPath: path,
    deviceId: device,
    progress: { page: 6, position: 0.5, updatedAt: 100 },
    bookmarks: {},
  }));
  storage.set("pdf-pager-hz:device:test-vault", device);
  const app = memoryApp(adapter, storage);

  const store = new StateStore(app);
  assert.equal((await store.load(path)).progress?.page, 6);
  assert.equal(adapter.files.has(`.obsidian/plugins/pdf-pager-hz/records/${recordFileName(path, device)}`), true);
});

test("record filenames expose the PDF title while retaining collision-resistant keys", () => {
  const path = "30_resource/book/科幻小说/盲视 ((加) 彼得·沃茨) .pdf";
  const device = "4bc4260a-2bcd-411c-9fd7-a403ee56a890";
  assert.equal(
    recordFileName(path, device),
    `盲视 ((加) 彼得·沃茨)__${pathKey(path)}__设备-${pathKey(device)}.json`,
  );
  assert.equal(recordFileName("资料/Windows:入门?.pdf", device).includes(":"), false);
});

test("opaque legacy filenames migrate to readable names without changing record data", async () => {
  const adapter = new MemoryAdapter();
  const storage = new Map<string, unknown>();
  const app = memoryApp(adapter, storage);
  const root = "99_assets/plugin-data/pdf-pager";
  const path = "资料/同步书.pdf";
  const device = "device-aaaaaaaa";
  const oldFile = `${root}/${pathKey(path)}-${device}.json`;
  const newFile = `${root}/${recordFileName(path, device)}`;
  adapter.folders.add(root);
  adapter.files.set(oldFile, JSON.stringify({
    version: 1, pdfPath: path, deviceId: device,
    progress: { page: 18, position: 0.25, updatedAt: 100 }, bookmarks: {}, sessions: {},
  }));
  storage.set("pdf-pager-hz:device:test-vault", device);

  const store = new StateStore(app, root);
  assert.equal(await store.migrateReadableFileNames(), 1);
  assert.equal(adapter.files.has(oldFile), false);
  assert.equal(adapter.files.has(newFile), true);
  assert.equal((await store.load(path)).progress?.page, 18);
});

test("reading sessions stay per-device and follow PDF renames", async () => {
  const adapter = new MemoryAdapter();
  const storage = new Map<string, unknown>();
  const app = memoryApp(adapter, storage);
  storage.set("pdf-pager-hz:device:test-vault", "device-aaaaaaaa");
  const first = new StateStore(app);
  await first.upsertReadingSession("资料/书.pdf", {
    id: "a-session", day: "2026-10-08", startedAt: 100, endedAt: 200, durationMs: 100,
    startPage: 1, endPage: 2, minPage: 1, maxPage: 2, updatedAt: 200,
  });
  storage.set("pdf-pager-hz:device:test-vault", "device-bbbbbbbb");
  const second = new StateStore(app);
  await second.upsertReadingSession("资料/书.pdf", {
    id: "b-session", day: "2026-10-08", startedAt: 300, endedAt: 400, durationMs: 100,
    startPage: 3, endPage: 4, minPage: 3, maxPage: 4, updatedAt: 400,
  });
  assert.deepEqual((await first.readingSessions()).map((item) => item.id), ["a-session", "b-session"]);
  await first.rename("资料/书.pdf", "资料/新书.pdf");
  const renamed = await second.readingSessions();
  assert.equal(renamed.every((item) => item.pdfPath === "资料/新书.pdf"), true);
});

test("custom record folder receives a merged copy without deleting the default records", async () => {
  const adapter = new MemoryAdapter();
  const storage = new Map<string, unknown>();
  const app = memoryApp(adapter, storage);
  storage.set("pdf-pager-hz:device:test-vault", "device-aaaaaaaa");
  const store = new StateStore(app);
  await store.recordProgress("资料/同步书.pdf", 12, 0.4);
  const defaultFile = `.obsidian/plugins/pdf-pager-hz/records/${recordFileName("资料/同步书.pdf", "device-aaaaaaaa")}`;
  assert.equal(adapter.files.has(defaultFile), true);

  const copied = await store.setRoot("99_assets/sync/pdf-pager");
  const customFile = `99_assets/sync/pdf-pager/${recordFileName("资料/同步书.pdf", "device-aaaaaaaa")}`;
  assert.equal(copied, 1);
  assert.equal(adapter.files.has(defaultFile), true);
  assert.equal(adapter.files.has(customFile), true);
  assert.equal((await store.load("资料/同步书.pdf")).progress?.page, 12);
});

test("a failed folder migration keeps subsequent writes in the previous record folder", async () => {
  const adapter = new MemoryAdapter();
  const storage = new Map<string, unknown>();
  const app = memoryApp(adapter, storage);
  storage.set("pdf-pager-hz:device:test-vault", "device-aaaaaaaa");
  const store = new StateStore(app);
  const path = "资料/迁移失败.pdf";
  await store.recordProgress(path, 4);

  adapter.failWritePrefix = "99_assets/sync/pdf-pager/";
  await assert.rejects(store.setRoot("99_assets/sync/pdf-pager"), /write failed/);
  adapter.failWritePrefix = undefined;
  await store.recordProgress(path, 7);

  const defaultFile = `.obsidian/plugins/pdf-pager-hz/records/${recordFileName(path, "device-aaaaaaaa")}`;
  const record = JSON.parse(adapter.files.get(defaultFile) ?? "null") as { progress?: { page?: number } };
  assert.equal(record.progress?.page, 7);
});

test("a device write advances beyond timestamps already synced from another device", async () => {
  const adapter = new MemoryAdapter();
  const storage = new Map<string, unknown>();
  const app = memoryApp(adapter, storage);
  const root = ".obsidian/plugins/pdf-pager-hz/records";
  const path = "资料/时钟偏差.pdf";
  const future = Date.now() + 24 * 60 * 60_000;
  adapter.folders.add(root);
  adapter.files.set(`${root}/${pathKey(path)}-device-aaaaaaaa.json`, JSON.stringify({
    version: 1,
    pdfPath: path,
    deviceId: "device-aaaaaaaa",
    progress: { page: 5, position: 0, updatedAt: future },
    bookmarks: {},
    sessions: {},
  }));
  storage.set("pdf-pager-hz:device:test-vault", "device-bbbbbbbb");
  const second = new StateStore(app);
  const state = await second.recordProgress(path, 9, 0.25);
  assert.equal(state.progress?.page, 9);
  assert.equal((state.progress?.updatedAt ?? 0) > future, true);
});
