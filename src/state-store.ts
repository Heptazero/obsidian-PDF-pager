import type { App } from "obsidian";
import { mergeRecords, pathKey, type Bookmark, type DeviceRecord, type ReadingState } from "./reading-state.ts";

const ROOT = "99_assets/plugin-data/pdf-pager";

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
  private own = new Map<string, DeviceRecord>();
  private pending = new Map<string, Promise<unknown>>();

  constructor(app: App) {
    this.app = app;
    this.device = deviceId(app.vault.getName());
  }

  private filePath(pdfPath: string, device = this.device): string {
    return `${ROOT}/${pathKey(pdfPath)}-${device}.json`;
  }

  private async ensureRoot(): Promise<void> {
    for (const folder of ["99_assets", "99_assets/plugin-data", ROOT]) {
      if (!await this.app.vault.adapter.exists(folder)) await this.app.vault.adapter.mkdir(folder);
    }
  }

  private async records(pdfPath: string): Promise<DeviceRecord[]> {
    if (!await this.app.vault.adapter.exists(ROOT)) return [];
    const prefix = `${pathKey(pdfPath)}-`;
    const list = await this.app.vault.adapter.list(ROOT);
    const files = list.files.filter((file) => file.slice(ROOT.length + 1).startsWith(prefix) && file.endsWith(".json"));
    const records = await Promise.all(files.map(async (file) => {
      try {
        const record = parseRecord(await this.app.vault.adapter.read(file));
        return record?.pdfPath.normalize("NFC") === pdfPath.normalize("NFC") ? record : null;
      } catch {
        return null;
      }
    }));
    return records.filter((record): record is DeviceRecord => record !== null);
  }

  async load(pdfPath: string): Promise<ReadingState> {
    const records = await this.records(pdfPath);
    const current = records.find((record) => record.deviceId === this.device);
    if (current) this.own.set(pdfPath, current);
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
      if (from !== to) await this.app.vault.adapter.remove(from);
      if (record.deviceId === this.device) this.own.set(newPath, renamed);
    }
    this.own.delete(oldPath);
  }

  async renamePrefix(oldFolder: string, newFolder: string): Promise<void> {
    if (!await this.app.vault.adapter.exists(ROOT)) return;
    const files = (await this.app.vault.adapter.list(ROOT)).files.filter((file) => file.endsWith(".json"));
    const paths = new Set<string>();
    for (const file of files) {
      try {
        const record = parseRecord(await this.app.vault.adapter.read(file));
        if (record?.pdfPath.startsWith(oldFolder + "/")) paths.add(record.pdfPath);
      } catch { /* Ignore unreadable sidecars. */ }
    }
    for (const path of paths) await this.rename(path, newFolder + path.slice(oldFolder.length));
  }
}
