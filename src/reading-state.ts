export interface Progress {
  page: number;
  updatedAt: number;
}

export interface Bookmark {
  id: string;
  page: number;
  label: string;
  updatedAt: number;
  deleted?: boolean;
}

export interface DeviceRecord {
  version: 1;
  pdfPath: string;
  deviceId: string;
  progress?: Progress;
  bookmarks: Record<string, Bookmark>;
}

export interface ReadingState {
  progress?: Progress;
  bookmarks: Bookmark[];
}

export function clampPage(page: number, total: number): number {
  return Math.max(1, Math.min(Math.trunc(page), Math.max(1, Math.trunc(total))));
}

/** Two independent 32-bit hashes keep vault-relative paths out of filenames. */
export function pathKey(path: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (const char of path.normalize("NFC")) {
    const code = char.codePointAt(0) ?? 0;
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x85ebca6b);
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}

export function mergeRecords(records: DeviceRecord[]): ReadingState {
  let progress: Progress | undefined;
  const bookmarks = new Map<string, Bookmark>();
  for (const record of records) {
    if (record.progress && (!progress || record.progress.updatedAt > progress.updatedAt)) {
      progress = record.progress;
    }
    for (const bookmark of Object.values(record.bookmarks ?? {})) {
      const previous = bookmarks.get(bookmark.id);
      if (!previous || bookmark.updatedAt > previous.updatedAt) bookmarks.set(bookmark.id, bookmark);
    }
  }
  return {
    progress,
    bookmarks: [...bookmarks.values()]
      .filter((bookmark) => !bookmark.deleted)
      .sort((a, b) => a.page - b.page || a.label.localeCompare(b.label)),
  };
}

export function shouldRecordPage(
  focused: boolean,
  restoring: boolean,
  armed: boolean,
  page: number,
  lastPage: number
): boolean {
  return focused && !restoring && armed && Number.isInteger(page) && page > 0 && page !== lastPage;
}
