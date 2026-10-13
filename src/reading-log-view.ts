import { FuzzySuggestModal, ItemView, Notice, TFile, setIcon, type App, type WorkspaceLeaf } from "obsidian";
import {
  aggregateReadingSessions, formatDuration, pageRange, shiftDay, weekDays, type BookDaySummary,
} from "./reading-log.ts";
import type { StateStore } from "./state-store.ts";

export const READING_LOG_VIEW = "pdf-pager-reading-log";

export interface SettlementResult {
  settled: TFile[];
  unresolved: BookDaySummary[];
}

export interface ReadingLogHost {
  app: App;
  store: StateStore;
  resolveReadingNote(pdfPath: string): Promise<TFile | null>;
  linkReadingNote(pdfPath: string, note: TFile): Promise<void>;
  settleReadingDay(day: string): Promise<SettlementResult>;
  openReadingNote(note: TFile, day?: string, pdfPath?: string): Promise<void>;
  getReadingLogPreferences(): { sessionMergeMinutes: number; mobileLogBottomPadding: number };
}

interface ResolvedSummary {
  summary: BookDaySummary;
  note: TFile | null;
}

function fileName(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/\.pdf$/i, "");
}

function bookHue(path: string): number {
  let hash = 0;
  for (const char of path.normalize("NFC")) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x45d9f3b);
  return Math.abs(hash) % 360;
}

function clock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

class NoteSuggestModal extends FuzzySuggestModal<TFile> {
  private files: TFile[];

  constructor(app: App, private pdfPath: string, private onChoose: (note: TFile) => void) {
    super(app);
    this.setPlaceholder(`为 ${fileName(pdfPath)} 选择书籍笔记`);
    this.files = app.vault.getMarkdownFiles().sort((a, b) => {
      const aBook = a.path.startsWith("20_self/25_record/") ? 0 : 1;
      const bBook = b.path.startsWith("20_self/25_record/") ? 0 : 1;
      return aBook - bBook || a.basename.localeCompare(b.basename);
    });
  }

  getItems(): TFile[] { return this.files; }
  getItemText(item: TFile): string { return `${item.basename}  ${item.path}`; }
  onChooseItem(item: TFile): void { this.onChoose(item); }
}

export class ReadingLogView extends ItemView {
  private revision = 0;
  private lastSignature = "";
  private loaded = false;
  private openSections = new Map<string, boolean>();
  private sectionStorageKey: string;

  constructor(leaf: WorkspaceLeaf, private host: ReadingLogHost) {
    super(leaf);
    this.sectionStorageKey = `pdf-pager-hz:log-sections:${host.app.vault.getName()}`;
    const stored: unknown = host.app.loadLocalStorage(this.sectionStorageKey);
    if (stored && typeof stored === "object") {
      for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
        if (typeof value === "boolean") this.openSections.set(key, value);
      }
    }
  }

  getViewType(): string { return READING_LOG_VIEW; }
  getDisplayText(): string { return "PDF 阅读日志"; }
  getIcon(): string { return "bar-chart-3"; }

  async onOpen(): Promise<void> {
    this.addAction("refresh-cw", "刷新阅读日志", () => void this.refresh(true));
    this.registerInterval(window.setInterval(() => void this.refresh(), 30_000));
    await this.refresh();
  }

  async refresh(force = false): Promise<void> {
    const revision = ++this.revision;
    const root = this.contentEl;
    const preferences = this.host.getReadingLogPreferences();
    root.addClass("pdf-pager-log-view");
    root.setCssProps({ "--pdf-pager-log-mobile-bottom-padding": `${preferences.mobileLogBottomPadding}px` });
    if (!this.loaded) {
      root.empty();
      root.createDiv({ cls: "pdf-pager-log-loading", text: "正在汇总阅读记录…" });
    }
    const sessions = await this.host.store.readingSessions();
    const signature = `${preferences.sessionMergeMinutes}|${preferences.mobileLogBottomPadding}|` + sessions.map((session) => [
      session.id, session.pdfPath, session.day, session.updatedAt, session.durationMs,
      session.startPage, session.endPage,
    ].join(":")).join("|");
    if (!force && this.loaded && signature === this.lastSignature) return;
    const summaries = aggregateReadingSessions(sessions, preferences.sessionMergeMinutes);
    if (revision !== this.revision) return;
    this.lastSignature = signature;
    this.loaded = true;
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const yesterdayKey = shiftDay(todayKey, -1);
    const resolved = await Promise.all(summaries.map(async (summary) => ({
      summary,
      note: await this.host.resolveReadingNote(summary.pdfPath),
    })));
    if (revision !== this.revision) return;
    root.empty();
    const heading = root.createDiv("pdf-pager-log-heading");
    const title = heading.createDiv();
    title.createEl("h2", { text: "PDF 阅读日志" });
    title.createDiv({ cls: "pdf-pager-log-subtitle", text: "阅读时自动记录，写日记时手动结算。" });
    const settle = heading.createEl("button", { cls: "mod-cta", text: "结算今天" });
    settle.disabled = !resolved.some((item) => item.summary.day === todayKey);
    settle.addEventListener("click", () => void this.settle(todayKey));

    this.renderDay(root, "today", "今天", todayKey, resolved, true, true);
    this.renderDay(root, "yesterday", "昨天", yesterdayKey, resolved, false, true);
    this.renderWeek(root, todayKey, resolved);
  }

  private renderDay(
    root: HTMLElement, key: string, label: string, day: string, items: ResolvedSummary[], open: boolean, allowSettle: boolean,
  ): void {
    const section = root.createEl("details", { cls: "pdf-pager-log-section" });
    section.open = this.openSections.get(key) ?? open;
    section.addEventListener("toggle", () => this.rememberSection(key, section.open));
    const summaryEl = section.createEl("summary");
    const dayItems = items.filter((item) => item.summary.day === day);
    summaryEl.createSpan({ text: label });
    summaryEl.createSpan({ cls: "pdf-pager-log-section-total", text: formatDuration(dayItems.reduce((sum, item) => sum + item.summary.durationMs, 0)) });
    const body = section.createDiv("pdf-pager-log-section-body");
    if (allowSettle && dayItems.length > 0 && label !== "今天") {
      const actions = body.createDiv("pdf-pager-log-day-actions");
      const settle = actions.createEl("button", { text: `结算${label}` });
      settle.addEventListener("click", () => void this.settle(day));
    }
    if (dayItems.length === 0) {
      body.createDiv({ cls: "pdf-pager-log-empty", text: "没有阅读记录" });
      return;
    }
    const grid = body.createDiv("pdf-pager-log-grid");
    for (const item of dayItems) this.renderBook(grid, item);
  }

  private renderBook(parent: HTMLElement, item: ResolvedSummary): void {
    const { summary, note } = item;
    const card = parent.createDiv("pdf-pager-log-book");
    card.setCssProps({ "--pdf-pager-book-hue": String(bookHue(summary.pdfPath)) });
    const heading = card.createDiv("pdf-pager-log-book-heading");
    heading.createSpan("pdf-pager-log-book-dot");
    heading.createDiv({ cls: "pdf-pager-log-book-title", text: fileName(summary.pdfPath), attr: { title: summary.pdfPath } });
    const metrics = card.createDiv("pdf-pager-log-book-metrics");
    metrics.createSpan({ text: formatDuration(summary.durationMs) });
    metrics.createSpan({ text: pageRange(summary).slice(1, -1).replace("-", "–") + " 页" });

    const noteRow = card.createDiv("pdf-pager-log-note-row");
    const noteButton = noteRow.createEl("button", {
      cls: note ? "pdf-pager-log-note" : "pdf-pager-log-note is-unlinked",
      text: note?.basename ?? "关联书籍笔记",
      attr: { title: note ? `打开 ${note.path} 的 ${summary.day} 日志` : "结算前需要选择书籍笔记" },
    });
    noteButton.addEventListener("click", () => {
      if (note) void this.host.openReadingNote(note, summary.day, summary.pdfPath);
      else this.chooseNote(summary.pdfPath);
    });
    if (note) {
      const change = noteRow.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "更换关联笔记", title: "更换关联笔记" } });
      setIcon(change, "pencil");
      change.addEventListener("click", () => this.chooseNote(summary.pdfPath));
    }

    const detail = card.createEl("details", { cls: "pdf-pager-log-sessions" });
    detail.createEl("summary", { text: `${summary.sessions.length} 段记录` });
    for (const session of summary.sessions) {
      const row = detail.createDiv("pdf-pager-log-session-row");
      row.createSpan({ text: `${clock(session.startedAt)}–${clock(session.endedAt)}` });
      row.createSpan({ text: formatDuration(session.durationMs) });
      row.createSpan({ text: `p${session.startPage}–${session.endPage}` });
    }
  }

  private renderWeek(root: HTMLElement, today: string, items: ResolvedSummary[]): void {
    const days = weekDays(today);
    const totals = days.map((day) => items
      .filter((item) => item.summary.day === day)
      .reduce((sum, item) => sum + item.summary.durationMs, 0));
    const section = root.createEl("details", { cls: "pdf-pager-log-section pdf-pager-log-week" });
    section.open = this.openSections.get("week") ?? true;
    section.addEventListener("toggle", () => this.rememberSection("week", section.open));
    const summary = section.createEl("summary");
    summary.createSpan({ text: "本周" });
    summary.createSpan({ cls: "pdf-pager-log-section-total", text: formatDuration(totals.reduce((sum, value) => sum + value, 0)) });
    const body = section.createDiv("pdf-pager-log-section-body");
    const chart = body.createDiv("pdf-pager-log-chart");
    const max = Math.max(...totals, 1);
    const labels = ["一", "二", "三", "四", "五", "六", "日"];
    for (let index = 0; index < days.length; index += 1) {
      const column = chart.createDiv("pdf-pager-log-chart-column");
      const value = column.createDiv({ cls: "pdf-pager-log-chart-value", text: totals[index] ? formatDuration(totals[index]) : "" });
      value.setAttribute("aria-label", `${days[index]} ${formatDuration(totals[index])}`);
      const track = column.createDiv("pdf-pager-log-chart-track");
      const stack = track.createDiv("pdf-pager-log-chart-stack");
      const dayItems = items.filter((item) => item.summary.day === days[index]);
      for (const item of dayItems) {
        const bar = stack.createDiv("pdf-pager-log-chart-bar");
        bar.setCssProps({
          "--pdf-pager-bar-height": `${Math.max(4, item.summary.durationMs / max * 100)}%`,
          "--pdf-pager-book-hue": String(bookHue(item.summary.pdfPath)),
        });
        bar.setAttribute("title", `${fileName(item.summary.pdfPath)} · ${formatDuration(item.summary.durationMs)}`);
      }
      column.createDiv({ cls: days[index] === today ? "pdf-pager-log-chart-label is-today" : "pdf-pager-log-chart-label", text: labels[index] });
    }
    const weekBooks = new Map<string, string>();
    for (const item of items) {
      if (days.includes(item.summary.day)) weekBooks.set(item.summary.pdfPath, fileName(item.summary.pdfPath));
    }
    if (weekBooks.size > 0) {
      const legend = body.createDiv("pdf-pager-log-legend");
      for (const [path, name] of weekBooks) {
        const entry = legend.createDiv("pdf-pager-log-legend-item");
        entry.setCssProps({ "--pdf-pager-book-hue": String(bookHue(path)) });
        entry.createSpan("pdf-pager-log-book-dot");
        entry.createSpan({ text: name, attr: { title: path } });
      }
    }
  }

  private chooseNote(pdfPath: string): void {
    new NoteSuggestModal(this.app, pdfPath, (note) => {
      void this.host.linkReadingNote(pdfPath, note).then(() => this.refresh(true));
    }).open();
  }

  private rememberSection(key: string, open: boolean): void {
    this.openSections.set(key, open);
    this.host.app.saveLocalStorage(this.sectionStorageKey, Object.fromEntries(this.openSections));
  }

  private async settle(day: string): Promise<void> {
    const result = await this.host.settleReadingDay(day);
    if (result.settled.length === 0 && result.unresolved.length > 0) {
      new Notice("请先为当天的 PDF 关联书籍笔记");
    } else if (result.unresolved.length > 0) {
      new Notice(`已结算 ${result.settled.length} 本；还有 ${result.unresolved.length} 本未关联笔记`);
    } else {
      new Notice(`已结算 ${result.settled.length} 本书；之后有新记录时可再次结算更新`);
    }
    await this.refresh(true);
    if (result.settled.length === 1 && result.unresolved.length === 0) await this.host.openReadingNote(result.settled[0]);
  }
}
