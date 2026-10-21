import { FuzzySuggestModal, ItemView, Notice, TFile, type App, type WorkspaceLeaf } from "obsidian";
import {
  aggregateReadingSessions, formatDuration, localDayKey, monthDays, pageRange, readingType, settlementStatus, shiftDay,
  UNCLASSIFIED_READING_TYPE, weekDays, type BookDaySummary, type SettlementStatus,
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
  settleReadingDay(day: string, pdfPaths?: string[]): Promise<SettlementResult>;
  openReadingNote(note: TFile, day?: string, pdfPath?: string): Promise<void>;
  openPdf(pdfPath: string): Promise<void>;
  getReadingLogPreferences(): { sessionMergeMinutes: number; dayEndMinutes: number; mobileLogBottomPadding: number };
}

interface ResolvedSummary {
  summary: BookDaySummary;
  note: TFile | null;
  status: SettlementStatus | "unlinked";
  type: string;
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

function dayLabel(day: string): string {
  const [, month, date] = day.split("-").map(Number);
  const weekday = ["日", "一", "二", "三", "四", "五", "六"];
  const value = new Date(`${day}T12:00:00`);
  return `${month}月${date}日 · 周${weekday[value.getDay()]}`;
}

function statusLabel(status: ResolvedSummary["status"]): string {
  if (status === "settled") return "已结算";
  if (status === "outdated") return "需更新";
  if (status === "unlinked") return "未关联";
  return "未结算";
}

function typeLabel(type: string): string {
  if (type === "book") return "书籍";
  if (type === "paper") return "论文";
  if (type === UNCLASSIFIED_READING_TYPE) return "未分类";
  return type;
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
  private typeStorageKey: string;
  private selectedType: string;

  constructor(leaf: WorkspaceLeaf, private host: ReadingLogHost) {
    super(leaf);
    this.sectionStorageKey = `pdf-pager-hz:log-sections:${host.app.vault.getName()}`;
    this.typeStorageKey = `pdf-pager-hz:log-type:${host.app.vault.getName()}`;
    const storedType: unknown = host.app.loadLocalStorage(this.typeStorageKey);
    this.selectedType = typeof storedType === "string" ? storedType : "*";
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
    this.registerEvent(this.app.metadataCache.on("changed", () => void this.refresh(true)));
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
    const signature = `${preferences.sessionMergeMinutes}|${preferences.dayEndMinutes}|${preferences.mobileLogBottomPadding}|` + sessions.map((session) => [
      session.id, session.pdfPath, session.day, session.updatedAt, session.durationMs,
      session.startPage, session.endPage,
    ].join(":")).join("|");
    if (!force && this.loaded && signature === this.lastSignature) return;
    const summaries = aggregateReadingSessions(sessions, preferences.sessionMergeMinutes);
    if (revision !== this.revision) return;
    this.lastSignature = signature;
    this.loaded = true;
    const todayKey = localDayKey(Date.now(), preferences.dayEndMinutes);
    const yesterdayKey = shiftDay(todayKey, -1);
    const resolved = await Promise.all(summaries.map(async (summary) => {
      const note = await this.host.resolveReadingNote(summary.pdfPath);
      if (!note) return { summary, note, status: "unlinked" as const, type: UNCLASSIFIED_READING_TYPE };
      const content = await this.app.vault.cachedRead(note);
      const frontmatter = this.app.metadataCache.getFileCache(note)?.frontmatter;
      return { summary, note, status: settlementStatus(content, summary), type: readingType(frontmatter?.type) };
    }));
    if (revision !== this.revision) return;
    const types = [...new Set(resolved.map((item) => item.type))].sort((a, b) => {
      if (a === UNCLASSIFIED_READING_TYPE) return 1;
      if (b === UNCLASSIFIED_READING_TYPE) return -1;
      return a.localeCompare(b, "zh-CN");
    });
    if (this.selectedType !== "*" && !types.includes(this.selectedType)) this.selectedType = "*";
    const visible = this.selectedType === "*" ? resolved : resolved.filter((item) => item.type === this.selectedType);
    root.empty();
    const heading = root.createDiv("pdf-pager-log-heading");
    const title = heading.createDiv();
    title.createEl("h2", { text: "PDF 阅读日志" });
    title.createDiv({ cls: "pdf-pager-log-subtitle", text: "阅读时自动记录，写日记时手动结算。" });
    this.renderTypeTabs(root, types);
    const todayItems = visible.filter((item) => item.summary.day === todayKey);
    const todaySettled = todayItems.length > 0 && todayItems.every((item) => item.status === "settled");
    const settle = heading.createEl("button", {
      cls: todaySettled ? undefined : "mod-cta",
      text: todaySettled ? "今日已结算" : todayItems.some((item) => item.status === "outdated") ? "更新今日结算" : "结算今天",
    });
    settle.disabled = todayItems.length === 0 || todaySettled;
    settle.addEventListener("click", () => void this.settle(todayKey, todayItems));

    this.renderDay(root, "today", "今天", todayKey, visible, true, true);
    this.renderDay(root, "yesterday", "昨天", yesterdayKey, visible, false, true);
    this.renderHistory(root, yesterdayKey, visible);
    this.renderWeek(root, todayKey, visible);
    this.renderMonth(root, todayKey, visible);
  }

  private renderTypeTabs(root: HTMLElement, types: string[]): void {
    const tabs = root.createDiv({
      cls: "pdf-pager-log-type-tabs",
      attr: { role: "tablist", "aria-label": "按笔记 type 筛选阅读统计" },
    });
    for (const type of ["*", ...types]) {
      const active = type === this.selectedType;
      const button = tabs.createEl("button", {
        cls: active ? "pdf-pager-log-type-tab is-active" : "pdf-pager-log-type-tab",
        text: type === "*" ? "全部" : typeLabel(type),
        attr: {
          role: "tab",
          "aria-selected": String(active),
          title: type === "*" ? "显示全部类型" : `type: ${type === UNCLASSIFIED_READING_TYPE ? "未设置" : type}`,
        },
      });
      button.addEventListener("click", () => {
        if (type === this.selectedType) return;
        this.selectedType = type;
        this.host.app.saveLocalStorage(this.typeStorageKey, type);
        void this.refresh(true);
      });
    }
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
    const allSettled = dayItems.length > 0 && dayItems.every((item) => item.status === "settled");
    if (allSettled) summaryEl.createSpan({ cls: "pdf-pager-log-settlement is-settled", text: "已结算" });
    if (allowSettle && dayItems.length > 0 && label !== "今天" && !allSettled) {
      const actions = body.createDiv("pdf-pager-log-day-actions");
      const settle = actions.createEl("button", {
        text: dayItems.some((item) => item.status === "outdated") ? `更新${label}结算` : `结算${label}`,
      });
      settle.addEventListener("click", () => void this.settle(day, dayItems));
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
    const identity = heading.createDiv("pdf-pager-log-book-identity");
    identity.createSpan("pdf-pager-log-book-dot");
    const title = identity.createEl("button", {
      cls: "pdf-pager-log-book-title",
      text: fileName(summary.pdfPath),
      attr: { title: `打开 ${summary.pdfPath}` },
    });
    title.addEventListener("click", () => void this.host.openPdf(summary.pdfPath));
    const metrics = heading.createDiv("pdf-pager-log-book-metrics");
    metrics.createSpan({ cls: "pdf-pager-log-book-duration", text: formatDuration(summary.durationMs) });
    metrics.createSpan({ cls: "pdf-pager-log-book-pages", text: pageRange(summary).slice(1, -1).replace("-", "–") + " 页" });

    const noteRow = card.createDiv("pdf-pager-log-note-row");
    noteRow.createSpan({ cls: "pdf-pager-log-note-label", text: "日志：" });
    const noteButton = noteRow.createEl("button", {
      cls: note ? "pdf-pager-log-note" : "pdf-pager-log-note is-unlinked",
      text: note?.basename ?? "选择关联笔记",
      attr: { title: note ? `打开 ${note.path} 的 ${summary.day} 日志` : "结算前需要选择书籍笔记" },
    });
    noteButton.addEventListener("click", () => {
      if (note) void this.host.openReadingNote(note, summary.day, summary.pdfPath);
      else this.chooseNote(summary.pdfPath);
    });
    noteRow.createSpan({
      cls: `pdf-pager-log-settlement is-${item.status}`,
      text: statusLabel(item.status),
    });

    const detail = card.createEl("details", { cls: "pdf-pager-log-sessions" });
    detail.createEl("summary", { text: `${summary.sessions.length} 段记录` });
    for (const session of summary.sessions) {
      const row = detail.createDiv("pdf-pager-log-session-row");
      row.createSpan({ text: `${clock(session.startedAt)}–${clock(session.endedAt)}` });
      row.createSpan({ text: formatDuration(session.durationMs) });
      row.createSpan({ text: `p${session.startPage}–${session.endPage}` });
    }
  }

  private renderHistory(root: HTMLElement, yesterday: string, items: ResolvedSummary[]): void {
    const days = [...new Set(items.map((item) => item.summary.day).filter((day) => day < yesterday))].sort().reverse();
    if (days.length === 0) return;
    const section = root.createEl("details", { cls: "pdf-pager-log-section pdf-pager-log-history" });
    section.open = this.openSections.get("history") ?? false;
    section.addEventListener("toggle", () => this.rememberSection("history", section.open));
    const summary = section.createEl("summary");
    summary.createSpan({ text: "更早" });
    summary.createSpan({ cls: "pdf-pager-log-section-total", text: `${days.length} 个阅读日` });
    const body = section.createDiv("pdf-pager-log-section-body pdf-pager-log-history-list");
    for (const day of days) {
      const dayItems = items.filter((item) => item.summary.day === day);
      const total = dayItems.reduce((sum, item) => sum + item.summary.durationMs, 0);
      const allSettled = dayItems.every((item) => item.status === "settled");
      const group = body.createEl("details", { cls: "pdf-pager-log-history-day" });
      const groupSummary = group.createEl("summary");
      groupSummary.createSpan({ text: dayLabel(day) });
      if (allSettled) groupSummary.createSpan({ cls: "pdf-pager-log-settlement is-settled", text: "已结算" });
      groupSummary.createSpan({ cls: "pdf-pager-log-section-total", text: formatDuration(total) });
      const content = group.createDiv("pdf-pager-log-history-day-body");
      if (!allSettled) {
        const actions = content.createDiv("pdf-pager-log-day-actions");
        const settle = actions.createEl("button", {
          text: dayItems.some((item) => item.status === "outdated") ? "更新这一天" : "结算这一天",
        });
        settle.addEventListener("click", () => void this.settle(day, dayItems));
      }
      const grid = content.createDiv("pdf-pager-log-grid");
      for (const item of dayItems) this.renderBook(grid, item);
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
    const labels = ["一", "二", "三", "四", "五", "六", "日"];
    const elapsed = Math.max(1, days.filter((day) => day <= today).length);
    this.renderChart(body, days, totals, labels, today, items, elapsed, false);
  }

  private renderMonth(root: HTMLElement, today: string, items: ResolvedSummary[]): void {
    const days = monthDays(today);
    const totals = days.map((day) => items
      .filter((item) => item.summary.day === day)
      .reduce((sum, item) => sum + item.summary.durationMs, 0));
    const section = root.createEl("details", { cls: "pdf-pager-log-section pdf-pager-log-month" });
    section.open = this.openSections.get("month") ?? false;
    section.addEventListener("toggle", () => this.rememberSection("month", section.open));
    const summary = section.createEl("summary");
    summary.createSpan({ text: "本月" });
    const readingDays = totals.filter((value) => value > 0).length;
    summary.createSpan({ cls: "pdf-pager-log-section-total", text: `${formatDuration(totals.reduce((sum, value) => sum + value, 0))} · 阅读 ${readingDays} 天` });
    const body = section.createDiv("pdf-pager-log-section-body");
    this.renderChart(body, days, totals, days.map((day) => String(Number(day.slice(-2)))), today, items, days.length, true);
  }

  private renderChart(
    body: HTMLElement, days: string[], totals: number[], labels: string[], today: string,
    items: ResolvedSummary[], averageDivisor: number, scrollable: boolean,
  ): void {
    const wrapper = scrollable ? body.createDiv("pdf-pager-log-chart-scroll") : body;
    const chart = wrapper.createDiv(scrollable ? "pdf-pager-log-chart is-month" : "pdf-pager-log-chart");
    chart.setCssProps({
      "--pdf-pager-chart-days": String(days.length),
      "--pdf-pager-chart-min-width": `${days.length * 42}px`,
    });
    const total = totals.reduce((sum, value) => sum + value, 0);
    const average = total / Math.max(1, averageDivisor);
    const max = Math.max(...totals, average, 1);
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
    const averageLine = chart.createDiv("pdf-pager-log-chart-average");
    averageLine.setCssProps({ "--pdf-pager-average-bottom": `${24 + average / max * 112}px` });
    averageLine.createSpan({ text: `日均 ${formatDuration(average)}` });
    const books = new Map<string, string>();
    for (const item of items) {
      if (days.includes(item.summary.day)) books.set(item.summary.pdfPath, fileName(item.summary.pdfPath));
    }
    if (books.size > 0) {
      const legend = body.createDiv("pdf-pager-log-legend");
      for (const [path, name] of books) {
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

  private async settle(day: string, items: ResolvedSummary[]): Promise<void> {
    const result = await this.host.settleReadingDay(day, items.map((item) => item.summary.pdfPath));
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
