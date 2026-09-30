import { FileView, Notice, Platform, Plugin, TFile, TFolder } from "obsidian";
import { clampPage, shouldRecordLocation, type Bookmark, type ReadingState } from "./reading-state";
import { getNativeViewer, hasExplicitPageTarget, NO_SPREAD, PAGE_MODE, type NativeViewer } from "./native-viewer";
import { PagerUi, type PagerActions } from "./pager-ui";
import { StateStore } from "./state-store";
import { centeredScrollLeft, relativeZoom, scaleForNewFloor } from "./zoom";
import { clampPosition, scrollTopForPosition, sliceCount, sliceIndexAtOffset, sliceOffset, slicePosition } from "./slices";

const SETTINGS_KEY = "pdf-pager-hz:display";

interface DisplaySettings {
  version: 2;
  fitMode: "auto" | "page-fit" | "page-width";
  factor: number;
}

function loadDisplaySettings(): DisplaySettings {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<DisplaySettings> | null;
    const fitMode = value?.version === 2
      ? value.fitMode === "page-fit" || value.fitMode === "page-width" ? value.fitMode : "auto"
      : value?.fitMode === "page-width" ? "page-width" : "auto";
    return {
      version: 2,
      fitMode,
      factor: typeof value?.factor === "number" && value.factor >= 0.7 && value.factor <= 1.6 ? value.factor : 1,
    };
  } catch {
    return { version: 2, fitMode: "auto", factor: 1 };
  }
}

function saveDisplaySettings(settings: DisplaySettings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* No persistent WebView storage. */ }
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
  private settings = loadDisplaySettings();

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
  private readonly onContainerScroll = () => this.scheduleSliceReadout();

  constructor(private plugin: PdfPagerPlugin, readonly view: FileView) {
    this.ui = new PagerUi(plugin.app, view, this);
    this.ui.setFactor(this.settings.factor);
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
        // Obsidian applies #page links asynchronously. Let explicit navigation win.
        if (!hasExplicitPageTarget(this.view) && pdf.currentPageNumber === 1 && this.lastObservedPage === 1 && state.progress) {
          pdf.currentPageNumber = clampPage(state.progress.page, this.pageCount());
          this.position = clampPosition(state.progress.position);
        }
        this.page = pdf.currentPageNumber;
        this.placePage(this.page);
        this.lastObservedPage = this.page;
        this.lastObservedPosition = this.position;
        this.armed = true;
        this.restoring = false;
        this.ui.update(this.page, this.pageCount(), this.state);
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
    const focused = this.plugin.app.workspace.activeLeaf?.view === this.view;
    const shouldSave = shouldRecordLocation(
      focused, this.restoring, this.armed, page, this.lastObservedPage, position, this.lastObservedPosition,
    );
    this.page = page;
    this.position = position;
    this.lastObservedPage = page;
    this.lastObservedPosition = position;
    this.ui.update(page, this.pageCount(), this.state);
    if (!shouldSave) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    const path = this.path;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      if (this.path !== path || this.page !== page || this.position !== position || this.plugin.app.workspace.activeLeaf?.view !== this.view) return;
      void this.plugin.store.recordProgress(path, page, position).then((state) => {
        if (this.path === path) { this.state = state; this.ui.update(this.page, this.pageCount(), state); }
      }).catch((error) => new Notice(`PDF 阅读进度保存失败：${String(error)}`));
    }, 550);
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

  previous(): void { this.navigateSlice(-1); }
  next(): void { this.navigateSlice(1); }

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
    saveDisplaySettings(this.settings);
    this.ui.setFactor(1);
    this.applyMode();
  }

  width(factor: number): void {
    if (!Number.isFinite(factor)) return;
    const oldFloor = this.minimumScale;
    this.settings.factor = Math.max(0.7, Math.min(1.6, factor));
    saveDisplaySettings(this.settings);
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
      this.sliceGuideHost = document.createElement("div");
      this.sliceGuideHost.className = "pdf-pager-slice-guides";
      this.sliceGuideHost.setAttribute("aria-hidden", "true");
      metrics.pageEl.append(this.sliceGuideHost);
      this.sliceGuidePage = metrics.pageEl;
    }
    const host = this.sliceGuideHost;
    if (!host) return;
    host.replaceChildren();
    for (let index = 1; index < count; index += 1) {
      const guide = document.createElement("div");
      guide.className = "pdf-pager-slice-guide";
      guide.style.top = `${sliceOffset(index, metrics.pageHeight, metrics.viewportHeight, count)}px`;
      const label = document.createElement("span");
      label.textContent = `${index + 1}/${count}`;
      guide.append(label);
      host.append(guide);
    }
  }

  toggleBar(): void { this.ui.toggleBar(); }

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
    this.disposed = true;
    this.clearTimers();
    if (this.attachTimer !== null) window.clearTimeout(this.attachTimer);
    this.resizeObserver?.disconnect();
    this.native?.eventBus.off("pagesinit", this.onPagesInit);
    this.native?.eventBus.off("pagechanging", this.onPageChanging);
    this.native?.eventBus.off("scalechanging", this.onScaleChanging);
    this.native?.pdfViewer.container.removeEventListener("scroll", this.onContainerScroll);
    this.restoreOriginal();
    this.ui.destroy();
  }
}

export default class PdfPagerPlugin extends Plugin {
  store!: StateStore;
  private sessions = new Map<FileView, PagerSession>();

  onload(): void {
    this.store = new StateStore(this.app);
    this.app.workspace.onLayoutReady(() => this.scan());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scan()));
    this.registerEvent(this.app.workspace.on("file-open", () => window.setTimeout(() => this.scan(), 0)));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scan()));
    this.registerEvent(this.app.workspace.on("resize", () => this.reflow()));
    this.registerDomEvent(window, "orientationchange", () => this.reflow());
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFolder || (file instanceof TFile && file.extension.toLowerCase() === "pdf"))) return;
      const newPath = file.path;
      const migration = file instanceof TFolder
        ? this.store.renamePrefix(oldPath, newPath)
        : this.store.rename(oldPath, newPath);
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
  }

  private activeSession(): PagerSession | null {
    const view = this.app.workspace.activeLeaf?.view;
    return view instanceof FileView && view.getViewType() === "pdf" ? this.sessions.get(view) ?? null : null;
  }

  private scan(): void {
    const views = new Set(this.app.workspace.getLeavesOfType("pdf").map((leaf) => leaf.view as FileView));
    for (const view of views) {
      const existing = this.sessions.get(view);
      if (existing) void existing.ensureAttached();
      else this.sessions.set(view, new PagerSession(this, view));
    }
    for (const [view, session] of this.sessions) {
      if (!views.has(view)) { session.dispose(); this.sessions.delete(view); }
    }
  }

  private reflow(): void { for (const session of this.sessions.values()) session.reflow(); }

  onunload(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}
