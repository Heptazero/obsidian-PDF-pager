import type { App } from "obsidian";
import {
  mergeRecords, pathKey, type Bookmark, type DeviceRecord, type ReadingSession, type ReadingState,
} from "./reading-state.ts";

const PLUGIN_ID = "pdf-pager-hz";
const LEGACY_ROOT = "99_assets/plugin-data/pdf-pager";

function uid(): string {
  return typeof window !== "undefined" && window.crypto?.randomUUID
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function deviceId(app: App): string {
  const key = `pdf-pager-hz:device:${app.vault.getName()}`;
  const previous: unknown = app.loadLocalStorage(key);
  if (typeof previous === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(previous)) return previous;
  const created = uid();
  app.saveLocalStorage(key, created);
  return created;
}

function parseRecord(raw: string): DeviceRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const record = value as Partial<DeviceRecord>;
    if (record.version !== 1 || typeof record.pdfPath !== "string" || typeof record.deviceId !== "string") return null;
    return {
      ...record,
      version: 1,
      pdfPath: record.pdfPath,
      deviceId: record.deviceId,
      bookmarks: record.bookmarks ?? {},
      sessions: record.sessions ?? {},
    };
  } catch {
    return null;
  }
}

function latestTimestamp(record: DeviceRecord): number {
  return Math.max(
    record.progress?.updatedAt ?? 0,
    ...Object.values(record.bookmarks).map((item) => item.updatedAt),
    ...Object.values(record.sessions ?? {}).map((item) => item.updatedAt),
  );
}

function mergeDeviceRecords(first: DeviceRecord, second: DeviceRecord): DeviceRecord {
  const merged: DeviceRecord = {
    ...first,
    pdfPath: second.pdfPath,
    bookmarks: { ...first.bookmarks },
    sessions: { ...first.sessions },
  };
  if (second.progress && (!merged.progress || second.progress.updatedAt > merged.progress.updatedAt)) {
    merged.progress = second.progress;
  }
  for (const [id, bookmark] of Object.entries(second.bookmarks ?? {})) {
    if (!merged.bookmarks[id] || bookmark.updatedAt > merged.bookmarks[id].updatedAt) merged.bookmarks[id] = bookmark;
  }
  for (const [id, session] of Object.entries(second.sessions ?? {})) {
    if (!merged.sessions?.[id] || session.updatedAt > merged.sessions[id].updatedAt) {
      merged.sessions ??= {};
      merged.sessions[id] = session;
    }
  }
  return merged;
}

export interface StoredReadingSession extends ReadingSession {
  pdfPath: string;
  deviceId: string;
}

export class StateStore {
  private readonly device: string;
  private readonly app: App;
  private root: string;
  private readonly defaultRoot: string;
  private own = new Map<string, DeviceRecord>();
  private pending = new Map<string, Promise<unknown>>();

  constructor(app: App, root?: string) {
    this.app = app;
    this.device = deviceId(app);
    this.defaultRoot = `${app.vault.configDir}/plugins/${PLUGIN_ID}/records`;
    this.root = root ?? this.defaultRoot;
  }

  private readRoots(): string[] {
    return [...new Set([this.root, this.defaultRoot, LEGACY_ROOT])];
  }

  private filePath(pdfPath: string, device = this.device, root = this.root): string {
    return `${root}/${pathKey(pdfPath)}-${device}.json`;
  }

  private async ensureFolder(path: string): Promise<void> {
    let current = "";
    for (const part of path.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!await this.app.vault.adapter.exists(current)) await this.app.vault.adapter.mkdir(current);
    }
  }

  private async ensureRoot(): Promise<void> {
    await this.ensureFolder(this.root);
  }

  private async records(pdfPath: string): Promise<DeviceRecord[]> {
    const prefix = `${pathKey(pdfPath)}-`;
    const batches = await Promise.all(this.readRoots().map(async (root) => {
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
      newestByDevice.set(record.deviceId, current ? mergeDeviceRecords(current, record) : record);
    }
    return [...newestByDevice.values()];
  }

  async readingSessions(): Promise<StoredReadingSession[]> {
    const newest = new Map<string, StoredReadingSession>();
    for (const root of this.readRoots()) {
      if (!await this.app.vault.adapter.exists(root)) continue;
      const files = (await this.app.vault.adapter.list(root)).files.filter((file) => file.endsWith(".json"));
      for (const file of files) {
        try {
          const record = parseRecord(await this.app.vault.adapter.read(file));
          if (!record) continue;
          for (const session of Object.values(record.sessions ?? {})) {
            const stored = { ...session, pdfPath: record.pdfPath, deviceId: record.deviceId };
            const previous = newest.get(session.id);
            if (!previous || stored.updatedAt > previous.updatedAt) newest.set(session.id, stored);
          }
        } catch { /* Ignore unreadable sidecars. */ }
      }
    }
    return [...newest.values()].sort((a, b) => a.startedAt - b.startedAt);
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
    return this.own.get(pdfPath) ?? { version: 1, pdfPath, deviceId: this.device, bookmarks: {}, sessions: {} };
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
      const peers = await this.records(pdfPath);
      const now = Math.max(Date.now(), latestTimestamp(record) + 1, ...peers.map((peer) => latestTimestamp(peer) + 1));
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

  async upsertReadingSession(pdfPath: string, session: ReadingSession): Promise<void> {
    await this.edit(pdfPath, (record, now) => {
      record.sessions ??= {};
      const previous = record.sessions[session.id];
      const next = { ...session, updatedAt: Math.max(session.updatedAt, now) };
      if (!previous || next.updatedAt >= previous.updatedAt) record.sessions[session.id] = next;
    });
  }

  async setRoot(root: string): Promise<number> {
    await Promise.all([...this.pending.values()].map((pending) => pending.catch(() => undefined)));
    if (root === this.root) return 0;
    const sourceRoots = this.readRoots();
    const records = new Map<string, DeviceRecord>();
    for (const source of sourceRoots) {
      if (!await this.app.vault.adapter.exists(source)) continue;
      for (const file of (await this.app.vault.adapter.list(source)).files.filter((path) => path.endsWith(".json"))) {
        try {
          const record = parseRecord(await this.app.vault.adapter.read(file));
          if (!record) continue;
          const key = `${record.pdfPath.normalize("NFC")}\0${record.deviceId}`;
          const current = records.get(key);
          records.set(key, current ? mergeDeviceRecords(current, record) : record);
        } catch { /* Ignore unreadable sidecars. */ }
      }
    }
    const previousRoot = this.root;
    const nextOwn = new Map<string, DeviceRecord>();
    this.root = root;
    try {
      await this.ensureRoot();
      for (const record of records.values()) {
        const destination = this.filePath(record.pdfPath, record.deviceId);
        let merged = record;
        try {
          const existing = parseRecord(await this.app.vault.adapter.read(destination));
          if (existing) merged = mergeDeviceRecords(existing, record);
        } catch { /* Destination does not exist yet. */ }
        await this.app.vault.adapter.write(destination, JSON.stringify(merged, null, 2) + "\n");
        if (record.deviceId === this.device) nextOwn.set(record.pdfPath, merged);
      }
      for (const [pdfPath, record] of nextOwn) this.own.set(pdfPath, record);
      return records.size;
    } catch (error) {
      this.root = previousRoot;
      throw error;
    }
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
          Object.assign(renamed, mergeDeviceRecords(existing, renamed));
        }
      } catch { /* No destination record yet. */ }
      await this.app.vault.adapter.write(to, JSON.stringify(renamed, null, 2) + "\n");
      if (from !== to && await this.app.vault.adapter.exists(from)) await this.app.vault.adapter.remove(from);
      for (const root of this.readRoots()) {
        const source = this.filePath(oldPath, record.deviceId, root);
        if (source !== to && await this.app.vault.adapter.exists(source)) await this.app.vault.adapter.remove(source);
      }
      if (record.deviceId === this.device) this.own.set(newPath, renamed);
    }
    this.own.delete(oldPath);
  }

  async renamePrefix(oldFolder: string, newFolder: string): Promise<void> {
    const paths = new Set<string>();
    for (const root of this.readRoots()) {
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
