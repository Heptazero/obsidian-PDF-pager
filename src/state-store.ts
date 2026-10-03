import type { App } from "obsidian";
import { mergeRecords, pathKey, type Bookmark, type DeviceRecord, type ReadingState } from "./reading-state.ts";

const PLUGIN_ID = "pdf-pager-hz";
const LEGACY_ROOT = "99_assets/plugin-data/pdf-pager";

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function deviceId(vaultName: string): string {
  const key = `pdf-pager-hz:device:${vaultName}`;
  try {
    const previous = localStorage.getItem(key);
    if (previous && /^[a-zA-Z0-9-]{8,80}$/.test(previous)) return previous;
    const created = uid();
    localStorage.setItem(key, created);
    return created;
  } catch {
    // WebView storage can be disabled. This limits sync isolation for this run.
    return uid();
  }
}

function parseRecord(raw: string): DeviceRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const record = value as Partial<DeviceRecord>;
    if (record.version !== 1 || typeof record.pdfPath !== "string" || typeof record.deviceId !== "string") return null;
    return { ...record, version: 1, pdfPath: record.pdfPath, deviceId: record.deviceId, bookmarks: record.bookmarks ?? {} };
  } catch {
    return null;
  }
}

function latestTimestamp(record: DeviceRecord): number {
  return Math.max(record.progress?.updatedAt ?? 0, ...Object.values(record.bookmarks).map((item) => item.updatedAt));
}

export class StateStore {
  private readonly device: string;
  private readonly app: App;
  private readonly root: string;
  private own = new Map<string, DeviceRecord>();
  private pending = new Map<string, Promise<unknown>>();

  constructor(app: App) {
    this.app = app;
    this.device = deviceId(app.vault.getName());
    this.root = `${app.vault.configDir}/plugins/${PLUGIN_ID}/records`;
  }

  private filePath(pdfPath: string, device = this.device, root = this.root): string {
    return `${root}/${pathKey(pdfPath)}-${device}.json`;
  }

  private async ensureRoot(): Promise<void> {
    // Adapter access is required because the plugin's config folder is hidden from the Vault API.
    if (!await this.app.vault.adapter.exists(this.root)) await this.app.vault.adapter.mkdir(this.root);
  }

  private async records(pdfPath: string): Promise<DeviceRecord[]> {
    const prefix = `${pathKey(pdfPath)}-`;
    const batches = await Promise.all([this.root, LEGACY_ROOT].map(async (root) => {
      if (!await this.app.vault.adapter.exists(root)) return [];
      const list = await this.app.vault.adapter.list(root);
      const files = list.files.filter((file) => file.slice(root.length + 1).startsWith(prefix) && file.endsWith(".json"));
      return Promise.all(files.map(async (file) => {
        try {
          const record = parseRecord(await this.app.vault.adapter.read(file));
          return record?.pdfPath.normalize("NFC") === pdfPath.normalize("NFC") ? record : null;
        } catch {
          return null;
        }
      }));
    }));
    const newestByDevice = new Map<string, DeviceRecord>();
    for (const record of batches.flat()) {
      if (!record) continue;
      const current = newestByDevice.get(record.deviceId);
      if (!current || latestTimestamp(record) > latestTimestamp(current)) newestByDevice.set(record.deviceId, record);
    }
    return [...newestByDevice.values()];
  }

  async load(pdfPath: string): Promise<ReadingState> {
    const records = await this.records(pdfPath);
    const current = records.find((record) => record.deviceId === this.device);
    if (current) {
      this.own.set(pdfPath, current);
      const currentPath = this.filePath(pdfPath);
      if (!await this.app.vault.adapter.exists(currentPath)) {
        await this.ensureRoot();
        await this.app.vault.adapter.write(currentPath, JSON.stringify(current, null, 2) + "\n");
      }
    }
    return mergeRecords(records);
  }

  private async localRecord(pdfPath: string): Promise<DeviceRecord> {
    const cached = this.own.get(pdfPath);
    if (cached) return cached;
    await this.load(pdfPath);
    return this.own.get(pdfPath) ?? { version: 1, pdfPath, deviceId: this.device, bookmarks: {} };
  }

  private serialize<T>(pdfPath: string, job: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(pdfPath) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(job);
    this.pending.set(pdfPath, next);
    void next.finally(() => {
      if (this.pending.get(pdfPath) === next) this.pending.delete(pdfPath);
    }).catch(() => undefined);
    return next;
  }

  private async edit(pdfPath: string, change: (record: DeviceRecord, now: number) => void): Promise<ReadingState> {
    return this.serialize(pdfPath, async () => {
      const record = await this.localRecord(pdfPath);
      const now = Math.max(Date.now(), latestTimestamp(record) + 1);
      change(record, now);
      await this.ensureRoot();
      await this.app.vault.adapter.write(this.filePath(pdfPath), JSON.stringify(record, null, 2) + "\n");
      this.own.set(pdfPath, record);
      return this.load(pdfPath);
    });
  }

  recordProgress(pdfPath: string, page: number, position = 0): Promise<ReadingState> {
    return this.edit(pdfPath, (record, now) => { record.progress = { page, position, updatedAt: now }; });
  }

  addBookmark(pdfPath: string, page: number): Promise<ReadingState> {
    return this.edit(pdfPath, (record, now) => {
      const bookmark: Bookmark = { id: uid(), page, label: `第 ${page} 页`, updatedAt: now };
      record.bookmarks[bookmark.id] = bookmark;
    });
  }

  deleteBookmark(pdfPath: string, bookmark: Bookmark): Promise<ReadingState> {
    return this.edit(pdfPath, (record, now) => {
      record.bookmarks[bookmark.id] = { ...bookmark, updatedAt: now, deleted: true };
    });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.pending.get(oldPath)?.catch(() => undefined);
    const records = await this.records(oldPath);
    if (records.length === 0) return;
    await this.ensureRoot();
    for (const record of records) {
      const from = this.filePath(oldPath, record.deviceId);
      const to = this.filePath(newPath, record.deviceId);
      const renamed = { ...record, pdfPath: newPath };
      try {
        const existing = parseRecord(await this.app.vault.adapter.read(to));
        if (existing?.pdfPath === newPath) {
          renamed.progress = mergeRecords([existing, renamed]).progress;
          renamed.bookmarks = { ...existing.bookmarks };
          for (const [id, item] of Object.entries(record.bookmarks)) {
            if (!renamed.bookmarks[id] || item.updatedAt > renamed.bookmarks[id].updatedAt) renamed.bookmarks[id] = item;
          }
        }
      } catch { /* No destination record yet. */ }
      await this.app.vault.adapter.write(to, JSON.stringify(renamed, null, 2) + "\n");
      if (from !== to && await this.app.vault.adapter.exists(from)) await this.app.vault.adapter.remove(from);
      const legacyFrom = this.filePath(oldPath, record.deviceId, LEGACY_ROOT);
      if (await this.app.vault.adapter.exists(legacyFrom)) await this.app.vault.adapter.remove(legacyFrom);
      if (record.deviceId === this.device) this.own.set(newPath, renamed);
    }
    this.own.delete(oldPath);
  }

  async renamePrefix(oldFolder: string, newFolder: string): Promise<void> {
    const paths = new Set<string>();
    for (const root of [this.root, LEGACY_ROOT]) {
      if (!await this.app.vault.adapter.exists(root)) continue;
      const files = (await this.app.vault.adapter.list(root)).files.filter((file) => file.endsWith(".json"));
      for (const file of files) {
        try {
          const record = parseRecord(await this.app.vault.adapter.read(file));
          if (record?.pdfPath.startsWith(oldFolder + "/")) paths.add(record.pdfPath);
        } catch { /* Ignore unreadable sidecars. */ }
      }
    }
    for (const path of paths) await this.rename(path, newFolder + path.slice(oldFolder.length));
  }
}
