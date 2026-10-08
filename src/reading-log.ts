import { pathKey, type ReadingSession } from "./reading-state.ts";
import type { StoredReadingSession } from "./state-store.ts";

export interface BookDaySummary {
  day: string;
  pdfPath: string;
  durationMs: number;
  startPage: number;
  endPage: number;
  minPage: number;
  maxPage: number;
  sessions: StoredReadingSession[];
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function localDayKey(timestamp = Date.now()): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function shiftDay(day: string, amount: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return localDayKey(new Date(year, month - 1, date + amount, 12).getTime());
}

export function weekDays(day: string): string[] {
  const [year, month, date] = day.split("-").map(Number);
  const value = new Date(year, month - 1, date, 12);
  const mondayOffset = (value.getDay() + 6) % 7;
  const monday = localDayKey(new Date(year, month - 1, date - mondayOffset, 12).getTime());
  return Array.from({ length: 7 }, (_, index) => shiftDay(monday, index));
}

export function aggregateReadingSessions(sessions: StoredReadingSession[]): BookDaySummary[] {
  const groups = new Map<string, StoredReadingSession[]>();
  for (const session of sessions) {
    if (!session.day || !session.pdfPath || !Number.isFinite(session.durationMs) || session.durationMs <= 0) continue;
    const key = `${session.day}\0${session.pdfPath.normalize("NFC")}`;
    const group = groups.get(key) ?? [];
    group.push(session);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => {
    group.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
    const first = group[0];
    const last = group[group.length - 1];
    return {
      day: key.slice(0, key.indexOf("\0")),
      pdfPath: first.pdfPath,
      durationMs: group.reduce((total, session) => total + session.durationMs, 0),
      startPage: first.startPage,
      endPage: last.endPage,
      minPage: Math.min(...group.map((session) => session.minPage)),
      maxPage: Math.max(...group.map((session) => session.maxPage)),
      sessions: group,
    };
  }).sort((a, b) => b.day.localeCompare(a.day) || b.durationMs - a.durationMs || a.pdfPath.localeCompare(b.pdfPath));
}

export function formatDuration(durationMs: number): string {
  if (durationMs <= 0) return "0 分钟";
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

export function formatHourToken(durationMs: number): string {
  const rounded = Math.max(0.1, Math.round(durationMs / 360_000) / 10);
  return Number.isInteger(rounded) ? `${rounded}h` : `${rounded.toFixed(1)}h`;
}

export function pageRange(summary: Pick<BookDaySummary, "startPage" | "endPage">): string {
  return summary.startPage === summary.endPage
    ? `[${summary.startPage}]`
    : `[${summary.startPage}-${summary.endPage}]`;
}

export function settlementMarker(day: string, pdfPath: string): string {
  return `<!-- pdf-pager:${day}:${pathKey(pdfPath)} -->`;
}

export function settlementLine(summary: BookDaySummary): string {
  const monthDay = summary.day.slice(5).replace("-", "");
  return `- ${monthDay} ${pageRange(summary)} [${formatHourToken(summary.durationMs)}] ${settlementMarker(summary.day, summary.pdfPath)}`;
}

export interface SettlementUpdate {
  content: string;
  line: string;
  changed: boolean;
}

/** Update only the top-level daily row. Indented thoughts below it stay untouched. */
export function upsertDailySettlement(content: string, summary: BookDaySummary): SettlementUpdate {
  const line = settlementLine(summary);
  const marker = settlementMarker(summary.day, summary.pdfPath);
  const monthDay = summary.day.slice(5).replace("-", "");
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let logStart = lines.findIndex((value) => /^##\s+log\s*$/i.test(value.trim()));
  if (logStart < 0) {
    const separator = lines.length && lines[lines.length - 1] === "" ? [] : [""];
    lines.push(...separator, "## log", "", line);
    const updated = lines.join(newline);
    return { content: updated, line, changed: updated !== content };
  }
  let logEnd = lines.findIndex((value, index) => index > logStart && /^##\s+/.test(value));
  if (logEnd < 0) logEnd = lines.length;
  const managed = lines.findIndex((value, index) => index > logStart && index < logEnd && value.includes(marker));
  if (managed >= 0) {
    const changed = lines[managed] !== line;
    lines[managed] = line;
    return { content: lines.join(newline), line, changed };
  }

  const dayPattern = new RegExp(`^-\\s*${monthDay}(?=\\s|\\[|$)`);
  const sameDay = lines.findIndex((value, index) => index > logStart && index < logEnd && dayPattern.test(value));
  if (sameDay >= 0) {
    const tail = lines[sameDay]
      .replace(dayPattern, "")
      .replace(/\[\s*\+?\s*(?:\d+(?:\.\d+)?\s*-\s*)?\d+(?:\.\d+)?\s*h?\s*\]/gi, "")
      .replace(/<!--\s*(?:pdf-pager|btl):[^>]+-->/gi, "")
      .trim();
    const adopted = tail ? `${line} ${tail}` : line;
    const changed = lines[sameDay] !== adopted;
    lines[sameDay] = adopted;
    return { content: lines.join(newline), line: adopted, changed };
  }

  while (logEnd > logStart + 1 && lines[logEnd - 1] === "") logEnd -= 1;
  lines.splice(logEnd, 0, line);
  return { content: lines.join(newline), line, changed: true };
}

export function createReadingSession(id: string, day: string, timestamp: number, page: number): ReadingSession {
  return {
    id, day, startedAt: timestamp, endedAt: timestamp, durationMs: 0,
    startPage: page, endPage: page, minPage: page, maxPage: page, updatedAt: timestamp,
  };
}
