import type { App } from "obsidian";
import {
  mergeRecords, pathKey, type Bookmark, type DeviceRecord, type ReadingSession, type ReadingState,
} from "./reading-state.ts";

const PLUGIN_ID = "pdf-pager-hz";
const LEGACY_ROOT = "99_assets/plugin-data/pdf-pager";

function safeFileStem(pdfPath: string): string {
  const fileName = pdfPath.normalize("NFC").split("/").pop() ?? "";
  const withoutControls = [...fileName.replace(/\.pdf$/i, "").trim()]
    .map((character) => (character.codePointAt(0) ?? 0) < 32 ? "_" : character)
    .join("");
  const stem = withoutControls
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 48);
  return stem || "未命名PDF";
}

export function recordFileName(pdfPath: string, deviceId: string): string {
  const book = safeFileStem(pdfPath);
  const bookKey = pathKey(pdfPath);
  const deviceKey = pathKey(deviceId);
  return `${book}__${bookKey}__设备-${deviceKey}.json`;
}

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
    return `${root}/${recordFileName(pdfPath, device)}`;
  }

  private async rootRecords(
    root: string,
    accepts: (fileName: string) => boolean = () => true,
  ): Promise<Array<{ file: string; record: DeviceRecord }>> {
    if (!await this.app.vault.adapter.exists(root)) return [];
    const files = (await this.app.vault.adapter.list(root)).files.filter((file) => {
      const fileName = file.slice(root.length + 1);
      return file.endsWith(".json") && accepts(fileName);
    });
    const entries = await Promise.all(files.map(async (file) => {
      try {
        const record = parseRecord(await this.app.vault.adapter.read(file));
        return record ? { file, record } : null;
      } catch {
        return null;
      }
    }));
    return entries.filter((entry): entry is { file: string; record: DeviceRecord } => entry !== null);
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
    const normalizedPath = pdfPath.normalize("NFC");
    const key = pathKey(pdfPath);
    const accepts = (fileName: string) => fileName.startsWith(`${key}-`) || fileName.includes(`__${key}__设备-`);
    const batches = await Promise.all(this.readRoots().map((root) => this.rootRecords(root, accepts)));
    const newestByDevice = new Map<string, DeviceRecord>();
    for (const { record } of batches.flat()) {
      if (record.pdfPath.normalize("NFC") !== normalizedPath) continue;
      const current = newestByDevice.get(record.deviceId);
      newestByDevice.set(record.deviceId, current ? mergeDeviceRecords(current, record) : record);
    }
    return [...newestByDevice.values()];
  }

  async readingSessions(): Promise<StoredReadingSession[]> {
    const newest = new Map<string, StoredReadingSession>();
    for (const root of this.readRoots()) {
      for (const { record } of await this.rootRecords(root)) {
        for (const session of Object.values(record.sessions ?? {})) {
          const stored = { ...session, pdfPath: record.pdfPath, deviceId: record.deviceId };
          const previous = newest.get(session.id);
          if (!previous || stored.updatedAt > previous.updatedAt) newest.set(session.id, stored);
        }
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
      for (const { record } of await this.rootRecords(source)) {
        const key = `${record.pdfPath.normalize("NFC")}\0${record.deviceId}`;
        const current = records.get(key);
        records.set(key, current ? mergeDeviceRecords(current, record) : record);
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

  async migrateReadableFileNames(): Promise<number> {
    await Promise.all([...this.pending.values()].map((pending) => pending.catch(() => undefined)));
    let migrated = 0;
    for (const root of this.readRoots()) {
      for (const { file, record } of await this.rootRecords(root)) {
        const destination = this.filePath(record.pdfPath, record.deviceId, root);
        if (file === destination) continue;
        try {
          let merged = record;
          try {
            const existing = parseRecord(await this.app.vault.adapter.read(destination));
            if (existing?.pdfPath === record.pdfPath && existing.deviceId === record.deviceId) {
              merged = mergeDeviceRecords(existing, record);
            }
          } catch { /* The readable destination does not exist yet. */ }
          await this.app.vault.adapter.write(destination, JSON.stringify(merged, null, 2) + "\n");
          await this.app.vault.adapter.remove(file);
          if (root === this.root && record.deviceId === this.device) this.own.set(record.pdfPath, merged);
          migrated += 1;
        } catch { /* Keep the original file if migration cannot finish. */ }
      }
    }
    return migrated;
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
        for (const entry of await this.rootRecords(root)) {
          if (entry.file !== to && entry.record.deviceId === record.deviceId
            && entry.record.pdfPath.normalize("NFC") === oldPath.normalize("NFC")) {
            await this.app.vault.adapter.remove(entry.file);
          }
        }
      }
      if (record.deviceId === this.device) this.own.set(newPath, renamed);
    }
    this.own.delete(oldPath);
  }

  async renamePrefix(oldFolder: string, newFolder: string): Promise<void> {
    const paths = new Set<string>();
    for (const root of this.readRoots()) {
      for (const { record } of await this.rootRecords(root)) {
        if (record.pdfPath.startsWith(oldFolder + "/")) paths.add(record.pdfPath);
      }
    }
    for (const path of paths) await this.rename(path, newFolder + path.slice(oldFolder.length));
  }
}
