import { FileView, Notice, Platform, Plugin, TFile, TFolder, type App } from "obsidian";
import {
  clampPage, shouldRecordLocation, shouldRestoreProgress, type Bookmark, type ReadingSession, type ReadingState,
} from "./reading-state";
import { getNativeViewer, hasExplicitPageTarget, NO_SPREAD, PAGE_MODE, type NativeViewer } from "./native-viewer";
import { PagerUi, type PagerActions } from "./pager-ui";
import {
  aggregateReadingSessions, createReadingSession, localDayKey, normalizeReadingTypeName, normalizeReadingTypes,
  readingType, settlementBlockId, upsertDailySettlement,
} from "./reading-log";
import {
  READING_LOG_VIEW, ReadingLogView, type SettlementResult,
} from "./reading-log-view";
import { StateStore } from "./state-store";
import {
  PdfPagerSettingTab, normalizeRecordFolder, type PdfPagerSettings, type PdfPagerSettingsController,
} from "./settings";
import { centeredScrollLeft, relativeZoom, scaleForNewFloor } from "./zoom";
import { clampPosition, scrollTopForPosition, sliceCount, sliceIndexAtOffset, sliceOffset, slicePosition } from "./slices";
import { EPUB_VIEW, EpubReaderView, chooseEpub } from "./epub-view";
import { ensureEpubRegistration } from "./epub-registration";

const SETTINGS_KEY = "pdf-pager-hz:display";
const READING_TICK_MS = 15_000;
const READING_SAVE_MS = 30_000;

interface DisplaySettings {
  version: 2;
  fitMode: "auto" | "page-fit" | "page-width";
  factor: number;
}

function loadDisplaySettings(app: App): DisplaySettings {
  const loaded: unknown = app.loadLocalStorage(SETTINGS_KEY);
  const value = loaded && typeof loaded === "object" ? loaded as Partial<DisplaySettings> : null;
  const fitMode = value?.version === 2
    ? value.fitMode === "page-fit" || value.fitMode === "page-width" ? value.fitMode : "auto"
    : value?.fitMode === "page-width" ? "page-width" : "auto";
  return {
    version: 2,
    fitMode,
    factor: typeof value?.factor === "number" && value.factor >= 0.7 && value.factor <= 1.6 ? value.factor : 1,
  };
}

function saveDisplaySettings(app: App, settings: DisplaySettings): void {
  app.saveLocalStorage(SETTINGS_KEY, settings);
}

class PagerSession implements PagerActions {
  private native: NativeViewer | null = null;
  private ui: PagerUi;
  private path: string | null = null;
  private document: unknown = null;
  private state: ReadingState = { bookmarks: [] };
  private page = 1;
  private position = 0;
  private lastObservedPage = 1;
  private lastObservedPosition = 0;
  private requestedPosition: number | null = null;
  private armed = false;
  private restoring = false;
  private generation = 0;
  private disposed = false;
  private saveTimer: number | null = null;
  private reflowTimer: number | null = null;
  private restoreTimer: number | null = null;
  private zoomTimer: number | null = null;
  private attachTimer: number | null = null;
  private attaching = false;
  private attachFailures = 0;
  private orientation = window.innerWidth >= window.innerHeight;
  private reflowPage: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private baseScale = 0;
  private minimumScale = 0;
  private scaleClampFrame: number | null = null;
  private centerFrame: number | null = null;
  private sliceFrame: number | null = null;
  private sliceGuideHost: HTMLElement | null = null;
  private sliceGuidePage: HTMLElement | null = null;
  private layoutRevision = 0;
  private original: { scrollMode: number; spreadMode: number; scaleValue: string | number } | null = null;
  private modeErrorShown = false;
  private settings: DisplaySettings;
  private readingTimer: number;
  private reading: ReadingSession | null = null;
  private readingLastTick = 0;
  private readingLastActivity = 0;
  private readingLastSave = 0;
  private userInteractedWhileRestoring = false;
  private focusMode = false;

  private readonly onPagesInit = () => window.setTimeout(() => this.refreshFile(), 0);
  private readonly onPageChanging = (event: { pageNumber?: number }) => {
    const page = event.pageNumber ?? this.native?.pdfViewer.currentPageNumber;
    if (page) {
      const changed = page !== this.page;
      const position = this.requestedPosition ?? (changed ? page < this.page ? 1 : 0 : this.position);
      this.requestedPosition = null;
      this.observeLocation(page, position);
      if (changed) this.placePage(page, position);
    }
  };
  private readonly onScaleChanging = (event: { scale?: number }) => {
    this.scheduleSliceReadout();
    if (!this.minimumScale || !Number.isFinite(event.scale) || event.scale! >= this.minimumScale - 0.0001) return;
    if (this.scaleClampFrame !== null) return;
    this.scaleClampFrame = window.requestAnimationFrame(() => {
      this.scaleClampFrame = null;
      const pdf = this.native?.pdfViewer;
      if (pdf && pdf.currentScale < this.minimumScale) pdf.currentScaleValue = this.minimumScale;
    });
  };
  private readonly onContainerScroll = () => {
    this.scheduleSliceReadout();
    if (this.armed && !this.restoring) this.markReadingActivity();
  };
  private readonly onPointerDown = () => {
    if (!this.armed) this.userInteractedWhileRestoring = true;
    this.markReadingActivity();
  };
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (this.disposed || !this.isActive()) return;
    if (event.key === "Escape" && this.focusMode) {
      event.preventDefault();
      event.stopPropagation();
      this.toggleFocusMode();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.matches("input, textarea, select, button, [contenteditable='true']")) return;
    if (event.key === "ArrowLeft" || event.key === "PageUp") {
      if (!this.armed) this.userInteractedWhileRestoring = true;
      this.markReadingActivity();
      event.preventDefault();
      event.stopPropagation();
      this.previous();
    } else if (event.key === "ArrowRight" || event.key === "PageDown") {
      if (!this.armed) this.userInteractedWhileRestoring = true;
      this.markReadingActivity();
      event.preventDefault();
      event.stopPropagation();
      this.next();
    }
  };

  constructor(private plugin: PdfPagerPlugin, readonly view: FileView) {
    this.settings = loadDisplaySettings(plugin.app);
    this.ui = new PagerUi(plugin.app, view, this);
    this.ui.setFactor(this.settings.factor);
    view.containerEl.addEventListener("keydown", this.onKeyDown, true);
    view.containerEl.addEventListener("pointerdown", this.onPointerDown, true);
    this.readingTimer = window.setInterval(() => this.readingTick(), READING_TICK_MS);
    this.resizeObserver = new ResizeObserver(() => this.reflow());
    this.resizeObserver.observe(view.containerEl);
    void this.ensureAttached();
  }

  async ensureAttached(): Promise<void> {
    if (this.disposed || this.attaching) return;
    this.attaching = true;
    let native: NativeViewer | null;
    try { native = await getNativeViewer(this.view); }
    catch { native = null; }
    finally { this.attaching = false; }
    if (this.disposed) return;
    if (!native) {
      if (++this.attachFailures === 20) new Notice("无法连接到原生 PDF 阅读器；请重新打开 PDF 后重载插件");
      if (this.attachTimer !== null) window.clearTimeout(this.attachTimer);
      if (this.attachFailures < 20) this.attachTimer = window.setTimeout(() => void this.ensureAttached(), 250);
      return;
    }
    this.attachFailures = 0;
    if (this.attachTimer !== null) window.clearTimeout(this.attachTimer);
    this.attachTimer = null;
    if (this.native !== native) {
      this.native?.pdfViewer.container.removeEventListener("scroll", this.onContainerScroll);
      this.native?.eventBus.off("pagesinit", this.onPagesInit);
      this.native?.eventBus.off("pagechanging", this.onPageChanging);
      this.native?.eventBus.off("scalechanging", this.onScaleChanging);
      this.native = native;
      native.pdfViewer.container.addEventListener("scroll", this.onContainerScroll, { passive: true });
      native.eventBus.on("pagesinit", this.onPagesInit);
      native.eventBus.on("pagechanging", this.onPageChanging);
      native.eventBus.on("scalechanging", this.onScaleChanging);
    }
    this.refreshFile();
  }

  refreshFile(): void {
    const file = this.view.file;
    const pdf = this.native?.pdfViewer;
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf" || !pdf) return;
    const doc = pdf.pdfDocument;
    if (!doc || !Number.isInteger(doc.numPages) || doc.numPages < 1) return;
    if (this.path === file.path && this.document === doc) return;
    // FileView changes its `file` before pdf.js has replaced the previous PDF.
    if (this.path && file.path !== this.path && this.document === doc) return;
    this.restoreOriginal();
    this.path = file.path;
    this.document = doc;
    this.original = { scrollMode: pdf.scrollMode, spreadMode: pdf.spreadMode, scaleValue: pdf.currentScaleValue };
    this.armed = false;
    this.restoring = true;
    this.clearTimers();
    const generation = ++this.generation;
    this.page = Math.max(1, pdf.currentPageNumber);
    this.position = 0;
    this.lastObservedPage = this.page;
    this.lastObservedPosition = 0;
    this.requestedPosition = null;
    this.userInteractedWhileRestoring = false;
    this.state = { bookmarks: [] };
    this.baseScale = this.minimumScale = 0;
    this.ui.setFile(file.path, this.state, doc.numPages);
    this.ui.update(this.page, doc.numPages, this.state);
    this.applyMode();
    void this.initialize(file.path, doc, generation);
  }

  private async initialize(path: string, doc: unknown, generation: number): Promise<void> {
    try {
      const state = await this.plugin.store.load(path);
      if (!this.isCurrent(path, doc, generation)) return;
      this.state = state;
      this.ui.update(this.page, this.pageCount(), this.state);
      this.restoreTimer = window.setTimeout(() => {
        if (!this.isCurrent(path, doc, generation) || !this.native) return;
        const pdf = this.native.pdfViewer;
        // Explicit #page links and navigation performed while loading still win.
        const savedProgress = state.progress;
        if (shouldRestoreProgress(hasExplicitPageTarget(this.view), this.userInteractedWhileRestoring, savedProgress)) {
          this.requestedPosition = clampPosition(savedProgress!.position);
          this.position = this.requestedPosition;
          pdf.currentPageNumber = clampPage(savedProgress!.page, this.pageCount());
        }
        this.page = pdf.currentPageNumber;
        this.placePage(this.page);
        this.lastObservedPage = this.page;
        this.lastObservedPosition = this.position;
        this.armed = true;
        this.restoring = false;
        this.ui.update(this.page, this.pageCount(), this.state);
        this.markReadingActivity();
      }, 900);
    } catch (error) {
      this.armed = true;
      this.restoring = false;
      new Notice(`PDF 阅读进度读取失败：${String(error)}`);
    }
  }

  private isCurrent(path: string, doc: unknown, generation: number): boolean {
    return !this.disposed && this.path === path && this.document === doc && this.generation === generation;
  }

  private isActive(): boolean {
    return this.plugin.app.workspace.getActiveViewOfType(FileView) === this.view;
  }

  private pageCount(): number {
    return this.native?.pdfViewer.pdfDocument?.numPages ?? 1;
  }

  private landscapeSlices(): boolean {
    return Platform.isMobile && window.innerWidth >= window.innerHeight;
  }

  private effectiveFitMode(): "page-fit" | "page-width" {
    return this.settings.fitMode === "auto"
      ? this.landscapeSlices() ? "page-width" : "page-fit"
      : this.settings.fitMode;
  }

  private observeLocation(page: number, position = this.position): void {
    if (!this.path) return;
    position = clampPosition(position);
    const orientation = window.innerWidth >= window.innerHeight;
    if (orientation !== this.orientation) {
      this.orientation = orientation;
      this.position = position;
      this.reflow();
      return;
    }
    const focused = this.isActive();
    const shouldSave = shouldRecordLocation(
      focused, this.restoring, this.armed, page, this.lastObservedPage, position, this.lastObservedPosition,
    );
    this.page = page;
    this.position = position;
    this.lastObservedPage = page;
    this.lastObservedPosition = position;
    this.ui.update(page, this.pageCount(), this.state);
    if (!this.restoring) this.markReadingActivity();
    if (!shouldSave) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    const path = this.path;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      if (this.path !== path || this.page !== page || this.position !== position || !this.isActive()) return;
      void this.plugin.store.recordProgress(path, page, position).then((state) => {
        if (this.path === path) { this.state = state; this.ui.update(this.page, this.pageCount(), state); }
      }).catch((error) => new Notice(`PDF 阅读进度保存失败：${String(error)}`));
    }, 550);
  }

  private readingId(): string {
    return window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private markReadingActivity(timestamp = Date.now()): void {
    if (!this.path || !this.armed || this.restoring || !this.isActive() || document.hidden) return;
    const day = localDayKey(timestamp, this.plugin.readingDayEndMinutes);
    if (this.reading && (timestamp - this.readingLastActivity > this.plugin.readingIdleMs || this.reading.day !== day)) {
      this.persistReadingSession(true);
      this.reading = null;
    }
    if (!this.reading) {
      this.reading = createReadingSession(this.readingId(), day, timestamp, this.page);
      this.readingLastTick = timestamp;
      this.readingLastSave = timestamp;
    }
    this.readingLastActivity = timestamp;
    this.reading.endPage = this.page;
    this.reading.minPage = Math.min(this.reading.minPage, this.page);
    this.reading.maxPage = Math.max(this.reading.maxPage, this.page);
  }

  private readingTick(timestamp = Date.now()): void {
    const session = this.reading;
    if (!session) return;
    if (!this.path || !this.isActive() || document.hidden || timestamp - this.readingLastActivity > this.plugin.readingIdleMs) {
      this.persistReadingSession(true);
      this.reading = null;
      return;
    }
    if (session.day !== localDayKey(timestamp, this.plugin.readingDayEndMinutes)) {
      this.persistReadingSession(true);
      this.reading = null;
      this.markReadingActivity(timestamp);
      return;
    }
    const elapsed = Math.max(0, Math.min(timestamp - this.readingLastTick, READING_TICK_MS * 1.5));
    session.durationMs += elapsed;
    session.endedAt = timestamp;
    session.updatedAt = timestamp;
    session.endPage = this.page;
    session.minPage = Math.min(session.minPage, this.page);
    session.maxPage = Math.max(session.maxPage, this.page);
    this.readingLastTick = timestamp;
    if (timestamp - this.readingLastSave >= READING_SAVE_MS) this.persistReadingSession();
  }

  private persistReadingSession(force = false): void {
    if (!this.path || !this.reading || this.reading.durationMs < 5_000) return;
    if (!force && this.reading.updatedAt - this.readingLastSave < READING_SAVE_MS) return;
    const path = this.path;
    const snapshot = { ...this.reading };
    this.readingLastSave = snapshot.updatedAt;
    void this.plugin.store.upsertReadingSession(path, snapshot)
      .then(() => this.plugin.refreshReadingLog())
      .catch((error) => new Notice(`PDF 阅读时间保存失败：${String(error)}`));
  }

  syncReadingFocus(): void {
    if (this.isActive() && !document.hidden) this.markReadingActivity();
    else {
      this.persistReadingSession(true);
      this.reading = null;
    }
  }

  async flushReading(): Promise<void> {
    this.readingTick();
    if (!this.path || !this.reading || this.reading.durationMs < 5_000) return;
    const snapshot = { ...this.reading };
    this.readingLastSave = snapshot.updatedAt;
    await this.plugin.store.upsertReadingSession(this.path, snapshot);
    this.plugin.refreshReadingLog();
  }

  private applyMode(targetPage?: number, preserveZoom = false): void {
    const pdf = this.native?.pdfViewer;
    if (!pdf || !pdf.pdfDocument) return;
    const page = clampPage(targetPage ?? pdf.currentPageNumber ?? this.page, this.pageCount());
    const position = this.position;
    const oldFloor = this.minimumScale;
    const zoom = preserveZoom ? relativeZoom(pdf.currentScale, oldFloor) : 1;
    const revision = ++this.layoutRevision;
    this.restoring = true;
    // The intermediate fit preset may be below the old floor while it is recalculated.
    this.minimumScale = 0;
    // Reuse the existing PDF.js viewer. Page mode keeps one PDF page mounted.
    try {
      pdf.spreadMode = NO_SPREAD;
      pdf.scrollMode = PAGE_MODE;
      pdf.currentScaleValue = this.effectiveFitMode();
    } catch {
      this.minimumScale = oldFloor;
      this.restoring = false;
      if (!this.modeErrorShown) {
        this.modeErrorShown = true;
        new Notice("当前 Obsidian 版本无法切换 PDF 单页模式；阅读进度与书签仍可使用");
      }
      return;
    }
    window.requestAnimationFrame(() => {
      if (this.disposed || this.native?.pdfViewer !== pdf || revision !== this.layoutRevision) return;
      const base = pdf.currentScale;
      if (Number.isFinite(base) && base > 0) {
        this.baseScale = base;
        this.minimumScale = base * this.settings.factor;
        if (this.settings.factor !== 1 || zoom !== 1) pdf.currentScaleValue = this.minimumScale * zoom;
      }
      pdf.currentPageNumber = page;
      this.position = position;
      this.placePage(page, position);
      this.page = page;
      this.lastObservedPage = page;
      this.lastObservedPosition = position;
      this.ui.update(page, this.pageCount(), this.state);
      window.setTimeout(() => { if (!this.disposed) this.restoring = false; }, 260);
    });
  }

  reflow(): void {
    if (this.reflowPage === null) this.reflowPage = this.page;
    this.restoring = true;
    if (this.reflowTimer !== null) window.clearTimeout(this.reflowTimer);
    this.reflowTimer = window.setTimeout(() => {
      this.reflowTimer = null;
      const page = this.reflowPage;
      this.reflowPage = null;
      if (this.native?.pdfViewer.pdfDocument) this.applyMode(page ?? undefined, true);
    }, 180);
  }

  previous(): void {
    if (!this.armed) this.userInteractedWhileRestoring = true;
    this.markReadingActivity();
    this.navigateSlice(-1);
  }

  next(): void {
    if (!this.armed) this.userInteractedWhileRestoring = true;
    this.markReadingActivity();
    this.navigateSlice(1);
  }

  private navigateSlice(direction: -1 | 1): void {
    const pdf = this.native?.pdfViewer;
    if (!pdf) return;
    const count = this.currentSliceCount();
    const index = this.currentSliceIndex(count);
    const targetIndex = index + direction;
    if (targetIndex >= 0 && targetIndex < count) {
      const metrics = this.pageMetrics();
      const position = metrics
        ? slicePosition(targetIndex, metrics.pageHeight, metrics.viewportHeight, count)
        : this.position;
      this.position = position;
      this.placePage(this.page, position);
      this.observeLocation(this.page, position);
      return;
    }
    const nextPage = clampPage(this.page + direction, this.pageCount());
    if (nextPage === this.page) return;
    const position = direction > 0 ? 0 : 1;
    this.requestedPosition = position;
    if (this.reflowPage !== null) this.reflowPage = nextPage;
    pdf.currentPageNumber = nextPage;
    this.position = position;
    this.observeLocation(nextPage, position);
    this.placePage(nextPage, position);
  }

  goTo(page: number): void {
    const pdf = this.native?.pdfViewer;
    if (!pdf || !Number.isFinite(page)) return;
    if (!this.armed) this.userInteractedWhileRestoring = true;
    this.markReadingActivity();
    const next = clampPage(page, this.pageCount());
    if (this.reflowPage !== null) this.reflowPage = next;
    this.requestedPosition = 0;
    pdf.currentPageNumber = next;
    this.position = 0;
    this.observeLocation(next, 0);
    this.placePage(next, 0);
  }

  addBookmark(): void {
    if (!this.path) return;
    const path = this.path;
    void this.plugin.store.addBookmark(path, this.page).then((state) => {
      if (this.path === path) { this.state = state; this.ui.update(this.page, this.pageCount(), state); }
    }).catch((error) => new Notice(`书签保存失败：${String(error)}`));
  }

  deleteBookmark(bookmark: Bookmark): void {
    if (!this.path) return;
    const path = this.path;
    void this.plugin.store.deleteBookmark(path, bookmark).then((state) => {
      if (this.path === path) { this.state = state; this.ui.update(this.page, this.pageCount(), state); }
    }).catch((error) => new Notice(`书签删除失败：${String(error)}`));
  }

  fit(mode: "page-fit" | "page-width"): void {
    this.settings = { version: 2, fitMode: mode, factor: 1 };
    saveDisplaySettings(this.plugin.app, this.settings);
    this.ui.setFactor(1);
    this.applyMode();
  }

  width(factor: number): void {
    if (!Number.isFinite(factor)) return;
    const oldFloor = this.minimumScale;
    this.settings.factor = Math.max(0.7, Math.min(1.6, factor));
    saveDisplaySettings(this.plugin.app, this.settings);
    this.ui.setFactor(this.settings.factor);
    if (this.zoomTimer !== null) window.clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => {
      this.zoomTimer = null;
      const pdf = this.native?.pdfViewer;
      if (!pdf || !this.baseScale) { this.applyMode(); return; }
      const floor = this.baseScale * this.settings.factor;
      const scale = scaleForNewFloor(pdf.currentScale, oldFloor, floor);
      this.minimumScale = floor;
      pdf.currentScaleValue = scale;
      this.placePage(pdf.currentPageNumber, this.position);
    }, 75);
  }

  openReadingNote(): void {
    if (this.path) void this.plugin.openReadingNoteForPdf(this.path)
      .catch((error) => new Notice(`打开书籍日志失败：${String(error)}`));
  }

  openReadingLog(): void { void this.plugin.openReadingLog(); }

  private pageMetrics(page = this.page): { container: HTMLElement; pageEl: HTMLElement; pageTop: number; pageHeight: number; viewportHeight: number } | null {
    const pdf = this.native?.pdfViewer;
    const container = pdf?.container;
    const pageEl = pdf?.getPageView?.(page - 1)?.div;
    if (!container || !pageEl?.isConnected) return null;
    const viewport = container.getBoundingClientRect();
    const sheet = pageEl.getBoundingClientRect();
    return {
      container,
      pageEl,
      pageTop: sheet.top - viewport.top + container.scrollTop,
      pageHeight: sheet.height,
      viewportHeight: container.clientHeight,
    };
  }

  private currentSliceCount(): number {
    const metrics = this.pageMetrics();
    return metrics ? sliceCount(metrics.pageHeight, metrics.viewportHeight, this.landscapeSlices()) : 1;
  }

  private currentSliceIndex(count = this.currentSliceCount()): number {
    const metrics = this.pageMetrics();
    if (!metrics) return 0;
    const offset = metrics.container.scrollTop - metrics.pageTop;
    return sliceIndexAtOffset(offset, metrics.pageHeight, metrics.viewportHeight, count);
  }

  private placePage(page: number, position = this.position): void {
    if (this.centerFrame !== null) window.cancelAnimationFrame(this.centerFrame);
    this.centerFrame = window.requestAnimationFrame(() => {
      this.centerFrame = null;
      const pdf = this.native?.pdfViewer;
      if (!pdf || pdf.currentPageNumber !== page) return;
      const metrics = this.pageMetrics(page);
      if (!metrics) return;
      const { container, pageEl, pageTop, pageHeight, viewportHeight } = metrics;
      const viewport = container.getBoundingClientRect();
      const sheet = pageEl.getBoundingClientRect();
      const delta = (sheet.left + sheet.width / 2) - (viewport.left + viewport.width / 2);
      container.scrollLeft = centeredScrollLeft(container.scrollLeft, container.clientWidth, delta, container.scrollWidth);
      const enabled = this.landscapeSlices() && pdf.scrollMode === PAGE_MODE;
      const scrollMax = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = scrollTopForPosition(pageTop, pageHeight, viewportHeight, enabled ? position : 0, scrollMax);
      this.updateSliceGuides(metrics, enabled, sliceCount(pageHeight, viewportHeight, enabled));
      this.scheduleSliceReadout();
    });
  }

  private scheduleSliceReadout(): void {
    if (this.sliceFrame !== null) return;
    this.sliceFrame = window.requestAnimationFrame(() => {
      this.sliceFrame = null;
      const pdf = this.native?.pdfViewer;
      const metrics = this.pageMetrics();
      if (!pdf || !metrics) return;
      const enabled = this.landscapeSlices() && pdf.scrollMode === PAGE_MODE;
      const count = sliceCount(metrics.pageHeight, metrics.viewportHeight, enabled);
      const offset = metrics.container.scrollTop - metrics.pageTop;
      const index = sliceIndexAtOffset(offset, metrics.pageHeight, metrics.viewportHeight, count);
      const position = enabled ? slicePosition(index, metrics.pageHeight, metrics.viewportHeight, count) : 0;
      this.updateSliceGuides(metrics, enabled, count);
      this.ui.setSlice(index, count);
      if (Math.abs(position - this.position) > 0.001) this.observeLocation(this.page, position);
    });
  }

  private updateSliceGuides(
    metrics: { pageEl: HTMLElement; pageHeight: number; viewportHeight: number },
    enabled: boolean,
    count: number,
  ): void {
    if (!enabled || count <= 1) {
      this.sliceGuideHost?.remove();
      this.sliceGuideHost = null;
      this.sliceGuidePage = null;
      return;
    }
    if (this.sliceGuidePage !== metrics.pageEl) {
      this.sliceGuideHost?.remove();
      this.sliceGuideHost = metrics.pageEl.createDiv({
        cls: "pdf-pager-slice-guides",
        attr: { "aria-hidden": "true" },
      });
      this.sliceGuidePage = metrics.pageEl;
    }
    const host = this.sliceGuideHost;
    if (!host) return;
    host.replaceChildren();
    for (let index = 1; index < count; index += 1) {
      const guide = host.createDiv("pdf-pager-slice-guide");
      guide.setCssProps({
        "--pdf-pager-slice-guide-top": `${sliceOffset(index, metrics.pageHeight, metrics.viewportHeight, count)}px`,
      });
      guide.createSpan({ text: `${index + 1}/${count}` });
    }
  }

  toggleBar(): void { this.ui.toggleBar(); }

  toggleFocusMode(): void {
    this.focusMode = !this.focusMode;
    this.plugin.syncFocusMode();
  }

  isFocusModeEnabled(): boolean { return this.focusMode; }

  focusDocument(): Document { return this.view.containerEl.ownerDocument; }

  applyFocusMode(active: boolean): void { this.ui.setFocusMode(this.focusMode, active); }

  async renamed(oldPath: string, newPath: string): Promise<void> {
    if (!this.path || (this.path !== oldPath && !this.path.startsWith(oldPath + "/"))) return;
    const path = newPath + this.path.slice(oldPath.length);
    this.path = path;
    ++this.generation;
    this.state = await this.plugin.store.load(path);
    if (this.path !== path || this.disposed) return;
    this.ui.setFile(path, this.state, this.pageCount());
    this.ui.update(this.page, this.pageCount(), this.state);
  }

  private restoreOriginal(): void {
    const pdf = this.native?.pdfViewer;
    if (!pdf || !this.original || this.document !== pdf.pdfDocument) return;
    const page = pdf.currentPageNumber;
    pdf.scrollMode = this.original.scrollMode;
    pdf.spreadMode = this.original.spreadMode;
    pdf.currentScaleValue = this.original.scaleValue;
    pdf.currentPageNumber = page;
    this.original = null;
  }

  private clearTimers(): void {
    for (const timer of [this.saveTimer, this.reflowTimer, this.restoreTimer, this.zoomTimer]) {
      if (timer !== null) window.clearTimeout(timer);
    }
    this.saveTimer = this.reflowTimer = this.restoreTimer = this.zoomTimer = null;
    this.reflowPage = null;
    if (this.scaleClampFrame !== null) window.cancelAnimationFrame(this.scaleClampFrame);
    if (this.centerFrame !== null) window.cancelAnimationFrame(this.centerFrame);
    if (this.sliceFrame !== null) window.cancelAnimationFrame(this.sliceFrame);
    this.scaleClampFrame = this.centerFrame = this.sliceFrame = null;
    this.sliceGuideHost?.remove();
    this.sliceGuideHost = null;
    this.sliceGuidePage = null;
  }

  dispose(): void {
    this.persistReadingSession(true);
    this.disposed = true;
    this.clearTimers();
    if (this.attachTimer !== null) window.clearTimeout(this.attachTimer);
    this.resizeObserver?.disconnect();
    this.native?.eventBus.off("pagesinit", this.onPagesInit);
    this.native?.eventBus.off("pagechanging", this.onPageChanging);
    this.native?.eventBus.off("scalechanging", this.onScaleChanging);
    this.native?.pdfViewer.container.removeEventListener("scroll", this.onContainerScroll);
    this.view.containerEl.removeEventListener("keydown", this.onKeyDown, true);
    this.view.containerEl.removeEventListener("pointerdown", this.onPointerDown, true);
    window.clearInterval(this.readingTimer);
    this.restoreOriginal();
    this.ui.destroy();
  }
}

export default class PdfPagerPlugin extends Plugin implements PdfPagerSettingsController {
  store!: StateStore;
  private sessions = new Map<FileView, PagerSession>();
  private focusDocuments = new Set<Document>();
  private data!: PdfPagerSettings;

  get readingIdleMs(): number { return this.data.idleMinutes * 60_000; }
  get readingDayEndMinutes(): number { return this.data.dayEndMinutes; }

  async onload(): Promise<void> {
    const loaded: unknown = await this.loadData();
    const saved = loaded && typeof loaded === "object" ? loaded as Partial<PdfPagerSettings> : {};
    const defaultFolder = `${this.app.vault.configDir}/plugins/${this.manifest.id}/records`;
    let recordFolder = defaultFolder;
    try { recordFolder = normalizeRecordFolder(saved.recordFolder ?? "", defaultFolder); }
    catch { recordFolder = defaultFolder; }
    const idleMinutes = [5, 10, 15, 30].includes(saved.idleMinutes ?? 0) ? saved.idleMinutes! : 5;
    const sessionMergeMinutes = [0, 5, 10, 15, 30, 60].includes(saved.sessionMergeMinutes ?? -1)
      ? saved.sessionMergeMinutes! : 10;
    const dayEndMinutes = Number.isFinite(saved.dayEndMinutes)
      ? Math.max(0, Math.min(1439, Math.round(saved.dayEndMinutes!))) : 0;
    const mobileLogBottomPadding = Number.isFinite(saved.mobileLogBottomPadding)
      ? Math.max(0, Math.min(160, Math.round(saved.mobileLogBottomPadding! / 8) * 8)) : 72;
    this.data = {
      version: 5,
      noteLinks: saved.noteLinks && typeof saved.noteLinks === "object" ? { ...saved.noteLinks } : {},
      readingTypes: normalizeReadingTypes(saved.readingTypes ?? []),
      recordFolder,
      idleMinutes,
      sessionMergeMinutes,
      dayEndMinutes,
      mobileLogBottomPadding,
    };
    this.store = new StateStore(this.app, recordFolder);
    await this.store.migrateReadableFileNames();
    this.addSettingTab(new PdfPagerSettingTab(this.app, this));
    this.registerView(READING_LOG_VIEW, (leaf) => new ReadingLogView(leaf, this));
    this.registerView(EPUB_VIEW, (leaf) => new EpubReaderView(leaf, this));
    try { this.registerExtensions(["epub"], EPUB_VIEW); }
    catch { /* Another reader owns EPUB; the explicit Pager command remains available. */ }
    this.addCommand({ id: "repair-epub-registration", name: "修复电子书文件识别", callback: () => {
      try {
        const status = ensureEpubRegistration(this.app, EPUB_VIEW, () => this.registerExtensions(["epub"], EPUB_VIEW));
        if (status === "unavailable") new Notice("当前版本无法检查文件识别，请重新加载本插件");
        else if (status === "other-reader") new Notice("电子书当前由其他阅读器识别，可用“打开电子书”选择本阅读器");
        else new Notice("电子书文件识别已就绪，可在文件列表中打开");
      } catch (error) { new Notice(`EPUB 文件识别恢复失败：${String(error)}`); }
    } });
    this.addCommand({ id: "open-epub", name: "打开电子书", callback: () => chooseEpub(this) });
    this.addRibbonIcon("book-open", "打开电子书", () => chooseEpub(this));
    for (const direction of [-1, 1] as const) {
      this.addCommand({ id: direction === 1 ? "epub-next" : "epub-previous", name: direction === 1 ? "EPUB：下一屏" : "EPUB：上一屏",
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(EpubReaderView);
          if (!checking) view?.turn(direction);
          return !!view;
        } });
    }
    this.addRibbonIcon("bar-chart-3", "阅读日志", () => void this.openReadingLog());
    this.app.workspace.onLayoutReady(() => this.scan());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scan()));
    this.registerEvent(this.app.workspace.on("file-open", () => window.setTimeout(() => this.scan(), 0)));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scan()));
    this.registerEvent(this.app.workspace.on("resize", () => this.reflow()));
    this.registerDomEvent(window, "orientationchange", () => this.reflow());
    this.registerDomEvent(document, "visibilitychange", () => this.syncReadingFocus());
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      void this.updateNoteLinksForRename(oldPath, file.path, file instanceof TFolder);
      if (!(file instanceof TFolder || (file instanceof TFile && ["pdf", "epub"].includes(file.extension.toLowerCase())))) return;
      const newPath = file.path;
      const migration = Promise.all(this.epubViews().map((view) => view.flushProgress())).then(() => file instanceof TFolder
        ? this.store.renamePrefix(oldPath, newPath)
        : this.store.rename(oldPath, newPath));
      void migration.then(async () => {
        await Promise.all([...this.sessions.values()].map((session) => session.renamed(oldPath, file.path)));
        this.scan();
      }).catch((error) => new Notice(`PDF 阅读记录迁移失败：${String(error)}`));
    }));
    this.addCommand({ id: "toggle-controls", name: "PDF：显示或隐藏翻页控制", checkCallback: (checking) => {
      const session = this.activeSession();
      if (!checking) session?.toggleBar();
      return !!session;
    } });
    this.addCommand({ id: "toggle-focus-mode", name: "PDF：切换专注模式", checkCallback: (checking) => {
      const session = this.activeSession();
      if (!checking) session?.toggleFocusMode();
      return !!session;
    } });
    this.addCommand({ id: "add-bookmark", name: "PDF：给当前页加书签", checkCallback: (checking) => {
      const session = this.activeSession();
      if (!checking) session?.addBookmark();
      return !!session;
    } });
    this.addCommand({ id: "fit-width", name: "PDF：适合屏幕宽度", checkCallback: (checking) => {
      const session = this.activeSession();
      if (!checking) session?.fit("page-width");
      return !!session;
    } });
    this.addCommand({ id: "fit-page", name: "PDF：适合整页", checkCallback: (checking) => {
      const session = this.activeSession();
      if (!checking) session?.fit("page-fit");
      return !!session;
    } });
    this.addCommand({ id: "previous-page", name: "PDF：上一屏/上一页", checkCallback: (checking) => {
      const session = this.activeSession();
      if (!checking) session?.previous();
      return !!session;
    } });
    this.addCommand({ id: "next-page", name: "PDF：下一屏/下一页", checkCallback: (checking) => {
      const session = this.activeSession();
      if (!checking) session?.next();
      return !!session;
    } });
    this.addCommand({ id: "open-reading-log", name: "打开阅读日志", callback: () => void this.openReadingLog() });
    this.addCommand({ id: "open-linked-reading-note", name: "PDF：打开关联书籍日志", checkCallback: (checking) => {
      const session = this.activeSession();
      if (!checking) session?.openReadingNote();
      return !!session;
    } });
    this.addCommand({ id: "settle-today", name: "结算今天的阅读", callback: () => {
      const day = localDayKey(Date.now(), this.data.dayEndMinutes);
      void this.settleReadingDay(day).then((result) => {
        if (result.unresolved.length) new Notice(`已结算 ${result.settled.length} 本；${result.unresolved.length} 本需要先关联书籍笔记`);
        else new Notice(`已结算 ${result.settled.length} 本书`);
      }).catch((error) => new Notice(`PDF 阅读结算失败：${String(error)}`));
    } });
  }

  private activeSession(): PagerSession | null {
    const view = this.app.workspace.getActiveViewOfType(FileView);
    return view?.getViewType() === "pdf" ? this.sessions.get(view) ?? null : null;
  }

  private scan(): void {
    // A reader disabled after our onload may remove its old extension registration.
    // Repair only a missing handler; an active reader keeps ownership.
    try { ensureEpubRegistration(this.app, EPUB_VIEW, () => this.registerExtensions(["epub"], EPUB_VIEW)); }
    catch { /* Keep PDF sessions available; the repair command reports registration failures. */ }
    const views = new Set(this.app.workspace.getLeavesOfType("pdf").map((leaf) => leaf.view as FileView));
    for (const view of views) {
      const existing = this.sessions.get(view);
      if (existing) void existing.ensureAttached();
      else this.sessions.set(view, new PagerSession(this, view));
    }
    for (const [view, session] of this.sessions) {
      if (!views.has(view)) { session.dispose(); this.sessions.delete(view); }
    }
    this.syncReadingFocus();
    this.syncFocusMode();
  }

  private reflow(): void { for (const session of this.sessions.values()) session.reflow(); }

  private syncReadingFocus(): void {
    for (const session of this.sessions.values()) session.syncReadingFocus();
  }

  syncFocusMode(): void {
    for (const document of this.focusDocuments) document.body.classList.remove("pdf-pager-focus-mode");
    this.focusDocuments.clear();
    const active = this.activeSession() ?? this.app.workspace.getActiveViewOfType(EpubReaderView);
    for (const session of this.sessions.values()) session.applyFocusMode(session === active && session.isFocusModeEnabled());
    for (const view of this.epubViews()) view.applyFocusMode(view === active && view.isFocusModeEnabled());
    if (!active?.isFocusModeEnabled()) return;
    const document = active.focusDocument();
    document.body.classList.add("pdf-pager-focus-mode");
    this.focusDocuments.add(document);
  }

  private async flushReading(): Promise<void> {
    await Promise.all([...this.sessions.values(), ...this.epubViews()].map((session) => session.flushReading()));
  }

  private epubViews(): EpubReaderView[] {
    return this.app.workspace.getLeavesOfType(EPUB_VIEW).map((leaf) => leaf.view)
      .filter((view): view is EpubReaderView => view instanceof EpubReaderView);
  }

  async openEpub(file: TFile): Promise<void> {
    const workspace = this.app.workspace;
    const existing = workspace.getLeavesOfType(EPUB_VIEW).find((leaf) => leaf.getViewState().state?.file === file.path);
    const leaf = existing ?? workspace.getLeaf("tab");
    try {
      await workspace.revealLeaf(leaf);
      workspace.setActiveLeaf(leaf, { focus: true });
      if (!existing) await leaf.setViewState({ type: EPUB_VIEW, state: { file: file.path }, active: true });
    } catch (error) {
      new Notice(`无法打开 EPUB：${String(error)}`);
    }
  }

  getPdfPagerSettings(): PdfPagerSettings { return this.data; }

  getReadingLogPreferences(): { sessionMergeMinutes: number; dayEndMinutes: number; mobileLogBottomPadding: number } {
    return {
      sessionMergeMinutes: this.data.sessionMergeMinutes,
      dayEndMinutes: this.data.dayEndMinutes,
      mobileLogBottomPadding: this.data.mobileLogBottomPadding,
    };
  }

  getReadingTypes(): string[] { return [...this.data.readingTypes]; }

  async addReadingType(value: string): Promise<string> {
    const type = normalizeReadingTypeName(value);
    if (!type) throw new Error("类型名称不能为空");
    if (type.length > 40) throw new Error("类型名称不能超过 40 个字符");
    const existing = this.data.readingTypes.find((item) => item.toLocaleLowerCase() === type.toLocaleLowerCase());
    if (existing) return existing;
    this.data.readingTypes.push(type);
    await this.saveData(this.data);
    this.refreshReadingLog(true);
    return type;
  }

  async setReadingNoteType(note: TFile, value: string | null): Promise<void> {
    const type = value === null ? "" : normalizeReadingTypeName(value);
    if (value !== null && !type) throw new Error("类型名称不能为空");
    if (type) await this.addReadingType(type);
    await this.app.fileManager.processFrontMatter(note, (frontmatter) => {
      const properties = frontmatter as Record<string, unknown>;
      if (type) properties.type = type;
      else delete properties.type;
    });
    this.refreshReadingLog(true);
  }

  async renameReadingType(previous: string, value: string, notes: TFile[]): Promise<string> {
    const next = normalizeReadingTypeName(value);
    if (!next) throw new Error("类型名称不能为空");
    if (next.length > 40) throw new Error("类型名称不能超过 40 个字符");
    const previousKey = previous.toLocaleLowerCase();
    const duplicate = this.data.readingTypes.find((item) => (
      item.toLocaleLowerCase() === next.toLocaleLowerCase() && item.toLocaleLowerCase() !== previousKey
    ));
    if (duplicate) throw new Error(`已经存在类型“${duplicate}”`);
    this.data.readingTypes = normalizeReadingTypes([
      ...this.data.readingTypes.map((item) => item.toLocaleLowerCase() === previousKey ? next : item),
      next,
    ]);
    for (const note of notes) {
      await this.app.fileManager.processFrontMatter(note, (frontmatter) => {
        const properties = frontmatter as Record<string, unknown>;
        if (readingType(properties.type).toLocaleLowerCase() === previousKey) properties.type = next;
      });
    }
    await this.saveData(this.data);
    this.refreshReadingLog(true);
    return next;
  }

  async deleteReadingType(value: string, notes: TFile[]): Promise<void> {
    const key = value.toLocaleLowerCase();
    this.data.readingTypes = this.data.readingTypes.filter((item) => item.toLocaleLowerCase() !== key);
    for (const note of notes) {
      await this.app.fileManager.processFrontMatter(note, (frontmatter) => {
        const properties = frontmatter as Record<string, unknown>;
        if (readingType(properties.type).toLocaleLowerCase() === key) delete properties.type;
      });
    }
    await this.saveData(this.data);
    this.refreshReadingLog(true);
  }

  async updateRecordFolder(path: string): Promise<void> {
    const fallback = `${this.app.vault.configDir}/plugins/${this.manifest.id}/records`;
    const normalized = normalizeRecordFolder(path, fallback);
    if (normalized === this.data.recordFolder) return;
    await this.flushReading();
    const copied = await this.store.setRoot(normalized);
    this.data.recordFolder = normalized;
    await this.saveData(this.data);
    this.refreshReadingLog();
    new Notice(`PDF 阅读记录目录已改为 ${normalized}，已复制 ${copied} 份设备记录`);
  }

  async updateIdleMinutes(minutes: number): Promise<void> {
    if (![5, 10, 15, 30].includes(minutes)) throw new Error("无操作暂停时间无效");
    this.data.idleMinutes = minutes;
    await this.saveData(this.data);
  }

  async updateSessionMergeMinutes(minutes: number): Promise<void> {
    if (![0, 5, 10, 15, 30, 60].includes(minutes)) throw new Error("阅读记录合并间隔无效");
    this.data.sessionMergeMinutes = minutes;
    await this.saveData(this.data);
    this.refreshReadingLog();
  }

  async updateDayEndMinutes(minutes: number): Promise<void> {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1439) throw new Error("阅读日结束时间无效");
    if (minutes === this.data.dayEndMinutes) return;
    await this.flushReading();
    this.data.dayEndMinutes = minutes;
    await this.saveData(this.data);
    this.syncReadingFocus();
    this.refreshReadingLog();
  }

  async updateMobileLogBottomPadding(pixels: number): Promise<void> {
    if (!Number.isFinite(pixels)) throw new Error("日志底部留白无效");
    this.data.mobileLogBottomPadding = Math.max(0, Math.min(160, Math.round(pixels / 8) * 8));
    await this.saveData(this.data);
    this.refreshReadingLog();
  }

  async openReadingLog(): Promise<void> {
    await this.flushReading();
    const existing = this.app.workspace.getLeavesOfType(READING_LOG_VIEW)[0];
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    if (!existing) await leaf.setViewState({ type: READING_LOG_VIEW, active: true });
    await this.app.workspace.revealLeaf(leaf);
    this.refreshReadingLog();
  }

  refreshReadingLog(force = false): void {
    for (const leaf of this.app.workspace.getLeavesOfType(READING_LOG_VIEW)) {
      if (leaf.view instanceof ReadingLogView) void leaf.view.refresh(force);
    }
  }

  async resolveReadingNote(pdfPath: string): Promise<TFile | null> {
    const linkedPath = this.data.noteLinks[pdfPath];
    const linked = linkedPath ? this.app.vault.getAbstractFileByPath(linkedPath) : null;
    if (linked instanceof TFile && linked.extension.toLowerCase() === "md") return linked;

    const candidates: TFile[] = [];
    for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      if (!targets[pdfPath]) continue;
      const file = this.app.vault.getAbstractFileByPath(source);
      if (file instanceof TFile && file.extension.toLowerCase() === "md") candidates.push(file);
    }
    if (candidates.length === 0) return null;
    const withLog: TFile[] = [];
    for (const candidate of candidates) {
      if (/^##\s+log\s*$/im.test(await this.app.vault.cachedRead(candidate))) withLog.push(candidate);
    }
    if (withLog.length === 1) return withLog[0];
    return candidates.length === 1 ? candidates[0] : null;
  }

  async linkReadingNote(pdfPath: string, note: TFile): Promise<void> {
    this.data.noteLinks[pdfPath] = note.path;
    await this.saveData(this.data);
  }

  async settleReadingDay(day: string, pdfPaths?: string[]): Promise<SettlementResult> {
    await this.flushReading();
    const allowed = pdfPaths ? new Set(pdfPaths.map((path) => path.normalize("NFC"))) : null;
    const summaries = aggregateReadingSessions(
      await this.store.readingSessions(), this.data.sessionMergeMinutes,
    ).filter((summary) => summary.day === day && (!allowed || allowed.has(summary.pdfPath.normalize("NFC"))));
    const settled: TFile[] = [];
    const unresolved = [];
    for (const summary of summaries) {
      const note = await this.resolveReadingNote(summary.pdfPath);
      if (!note) { unresolved.push(summary); continue; }
      await this.app.vault.process(note, (content) => upsertDailySettlement(content, summary).content);
      settled.push(note);
    }
    this.refreshReadingLog();
    return { settled, unresolved };
  }

  async openReadingNote(note: TFile, day?: string, pdfPath?: string): Promise<void> {
    let target = `${note.path}#log`;
    if (day && pdfPath) {
      const blockId = settlementBlockId(day, pdfPath);
      if ((await this.app.vault.cachedRead(note)).includes(`^${blockId}`)) target = `${note.path}#^${blockId}`;
    }
    await this.app.workspace.openLinkText(target, note.path, false);
  }

  async openPdf(pdfPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(pdfPath);
    if (file instanceof TFile && file.extension.toLowerCase() === "epub") { await this.openEpub(file); return; }
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") {
      new Notice("找不到这本书，文件可能已移动");
      return;
    }
    const workspace = this.app.workspace;
    const existing = workspace.getLeavesOfType("pdf").find((leaf) => leaf.getViewState().state?.file === file.path);
    const leaf = existing ?? workspace.getLeaf("tab");
    try {
      await workspace.revealLeaf(leaf);
      workspace.setActiveLeaf(leaf, { focus: true });
      if (!existing) await leaf.openFile(file, { active: true });
    } catch (error) {
      new Notice(`无法打开 PDF：${String(error)}`);
    }
  }

  async openReadingNoteForPdf(pdfPath: string): Promise<void> {
    const note = await this.resolveReadingNote(pdfPath);
    if (!note) {
      new Notice("没有找到关联书籍笔记；请先在阅读日志中关联");
      return;
    }
    await this.openReadingNote(note, localDayKey(Date.now(), this.data.dayEndMinutes), pdfPath);
  }

  private async updateNoteLinksForRename(oldPath: string, newPath: string, folder: boolean): Promise<void> {
    let changed = false;
    const next: Record<string, string> = {};
    for (const [pdfPath, notePath] of Object.entries(this.data.noteLinks)) {
      const renamedPdf = pdfPath === oldPath || (folder && pdfPath.startsWith(oldPath + "/"))
        ? newPath + pdfPath.slice(oldPath.length)
        : pdfPath;
      const renamedNote = notePath === oldPath || (folder && notePath.startsWith(oldPath + "/"))
        ? newPath + notePath.slice(oldPath.length)
        : notePath;
      if (renamedPdf !== pdfPath || renamedNote !== notePath) changed = true;
      next[renamedPdf] = renamedNote;
    }
    if (changed) {
      this.data.noteLinks = next;
      await this.saveData(this.data);
    }
  }

  onunload(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    for (const document of this.focusDocuments) document.body.classList.remove("pdf-pager-focus-mode");
    this.focusDocuments.clear();
  }
}
