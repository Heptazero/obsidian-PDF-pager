import { Component, FileView, FuzzySuggestModal, Modal, Notice, Platform, setIcon, type TFile, type WorkspaceLeaf } from "obsidian";
import { Book, type Contents, type Location, type NavItem, type Rendition } from "epubjs";
import { bindReaderDrag, createPanelHeader, setFocusButton, watchReaderToolbar } from "./reader-controls";
import type PdfPagerPlugin from "./main";
import { DEFAULT_EPUB_PREFERENCES, epubPageLayout, normalizeEpubPreferences, validEpubLocation, type EpubPreferences } from "./epub-state";
import type { Bookmark, EpubLocation } from "./reading-state";
import { ReadingTracker } from "./reading-tracker";

export const EPUB_VIEW = "pdf-pager-epub";
const PREFERENCES_KEY = "pdf-pager-hz:epub-display";

class EpubChoiceModal<T> extends FuzzySuggestModal<T> {
  constructor(app: PdfPagerPlugin["app"], placeholder: string, private items: T[], private label: (item: T) => string,
    private choose: (item: T) => void) { super(app); this.setPlaceholder(placeholder); }
  getItems(): T[] { return this.items; }
  getItemText(item: T): string { return this.label(item); }
  onChooseItem(item: T): void { this.choose(item); }
}

export function chooseEpub(plugin: PdfPagerPlugin): void {
  const files = plugin.app.vault.getFiles().filter((file) => file.extension.toLowerCase() === "epub");
  if (!files.length) { new Notice("库中没有电子书文件"); return; }
  new EpubChoiceModal(plugin.app, "搜索 EPUB", files, (file) => file.path,
    (file) => void plugin.openEpub(file)).open();
}

function icon(parent: HTMLElement, name: string, title: string, action: () => void): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "clickable-icon", attr: { title, "aria-label": title, type: "button" } });
  setIcon(button, name);
  button.addEventListener("click", action);
  return button;
}

interface Chapter {
  item: NavItem;
  depth: number;
}

function flattenToc(items: NavItem[], depth = 0): Chapter[] {
  return items.flatMap((item) => [{ item, depth }, ...flattenToc(item.subitems ?? [], depth + 1)]);
}

export class EpubReaderView extends FileView {
  private book: Book | null = null;
  private rendition: Rendition | null = null;
  private lifetime: Component | null = null;
  private revision = 0;
  private ready = false;
  private indexReady = false;
  private indexPromise: Promise<void> | null = null;
  private sectionCount = 1;
  private reformatting = false;
  private moving = false;
  private interacted = false;
  private navigationPending = false;
  private focus = false;
  private location: EpubLocation | null = null;
  private tracker: ReadingTracker | null = null;
  private toc: Chapter[] = [];
  private currentHref = "";
  private displayedCfi: string | null = null;
  private navigationAnchor: string | null = null;
  private queuedJump: string | null = null;
  private preferences: EpubPreferences;
  private area!: HTMLElement;
  private rail!: HTMLElement;
  private panel!: HTMLElement;
  private panelBody!: HTMLElement;
  private status!: HTMLButtonElement;
  private previousButton!: HTMLButtonElement;
  private nextButton!: HTMLButtonElement;
  private progressTimer: number | null = null;
  private layoutTimer: number | null = null;
  private pendingProgress: Promise<unknown> = Promise.resolve();
  private anchoredCfi: string | null = null;
  private queuedLocation: { path: string; location: EpubLocation } | null = null;
  private contentListeners = new Map<Document, () => void>();

  constructor(leaf: WorkspaceLeaf, private plugin: PdfPagerPlugin) {
    super(leaf);
    this.preferences = normalizeEpubPreferences(this.app.loadLocalStorage(PREFERENCES_KEY));
  }

  getViewType(): string { return EPUB_VIEW; }
  getDisplayText(): string { return this.file?.basename ?? "EPUB 阅读器"; }
  getIcon(): string { return "book-open"; }
  canAcceptExtension(extension: string): boolean { return extension.toLowerCase() === "epub"; }

  private isActive(): boolean {
    return this.ready && this.app.workspace.getActiveViewOfType(EpubReaderView) === this
      && !this.containerEl.ownerDocument.hidden;
  }

  async onLoadFile(file: TFile): Promise<void> {
    const revision = ++this.revision;
    await this.closeBook(false);
    if (revision !== this.revision) return;
    const lifetime = new Component();
    this.addChild(lifetime);
    this.lifetime = lifetime;
    this.contentEl.empty();
    this.contentEl.addClass("epub-pager");
    this.contentEl.removeClass("is-focus");
    this.focus = false;
    this.location = null;
    this.indexReady = false;
    this.indexPromise = null;
    this.sectionCount = 1;
    this.toc = [];
    this.currentHref = "";
    this.displayedCfi = null;
    this.navigationAnchor = null;
    this.queuedJump = null;
    this.interacted = false;
    this.navigationPending = false;
    this.anchoredCfi = null;
    const viewport = this.contentEl.createDiv("epub-pager-viewport pager-reader-viewport");
    this.area = viewport.createDiv("epub-pager-area");
    const message = this.area.createDiv({ cls: "epub-pager-message", text: "正在打开 EPUB…" });
    this.rail = viewport.createDiv("epub-pager-controls pager-reader-rail");
    this.previousButton = icon(this.rail, "chevron-left", "上一屏", () => this.turn(-1));
    this.status = this.rail.createEl("button", { text: "…", attr: { title: "阅读设置", "aria-label": "展开阅读设置", "aria-expanded": "false" } });
    this.status.addEventListener("click", () => this.togglePanel());
    this.nextButton = icon(this.rail, "chevron-right", "下一屏", () => this.turn(1));
    this.panel = viewport.createDiv("epub-pager-panel pager-reader-panel");
    this.panel.hidden = true;
    const handle = createPanelHeader(this.panel, "EPUB 阅读设置", () => this.togglePanel());
    bindReaderDrag(lifetime, viewport, this.panel, handle);
    this.panelBody = this.panel.createDiv();
    this.renderPanel();
    this.applyMargins();
    if (Platform.isMobile) {
      watchReaderToolbar(lifetime, this.contentEl, this.app.workspace);
      for (const event of ["touchstart", "touchmove"] as const) {
        lifetime.registerDomEvent(this.panel, event, (event) => event.stopPropagation(), { passive: true });
      }
    }
    this.status.setAttribute("aria-description", "长按拖动翻页控件");
    bindReaderDrag(lifetime, viewport, this.rail, this.rail, true);
    const activity = () => this.tracker?.activity();
    lifetime.registerDomEvent(this.area, "pointerdown", activity);
    if (Platform.isMobile) lifetime.register(this.bindPageGestures(this.contentEl, this.contentEl.ownerDocument));
    lifetime.registerDomEvent(this.contentEl, "keydown", (event) => this.onKey(event));
    lifetime.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncFocus()));
    lifetime.registerDomEvent(this.containerEl.ownerDocument, "visibilitychange", () => this.syncFocus());
    let started = false;
    const resize = new ResizeObserver(() => {
      if (started) {
        this.scheduleLayout();
      } else if (revision === this.revision && this.area.clientWidth > 1 && this.area.clientHeight > 1) {
        started = true;
        void this.loadBook(file, revision, lifetime, message);
      }
    });
    resize.observe(this.area);
    lifetime.register(() => resize.disconnect());
    const body = this.containerEl.ownerDocument.body;
    let dark = body.classList.contains("theme-dark");
    const theme = new MutationObserver(() => {
      const next = body.classList.contains("theme-dark");
      if (next === dark) return;
      dark = next;
      this.scheduleLayout();
    });
    theme.observe(body, { attributes: true, attributeFilter: ["class"] });
    lifetime.register(() => theme.disconnect());
  }

  private async loadBook(file: TFile, revision: number, lifetime: Component, message: HTMLElement): Promise<void> {
    try {
      const [data, state] = await Promise.all([this.app.vault.readBinary(file), this.plugin.store.load(file.path)]);
      if (revision !== this.revision) return;
      const book = new Book({ replacements: "blobUrl" });
      this.book = book;
      await book.open(data, "binary");
      await book.ready;
      if (revision !== this.revision) return;
      this.toc = flattenToc(book.navigation.toc);
      this.sectionCount = (book.spine.last()?.index ?? 0) + 1;
      // The iframe keeps scripts disabled. CSP also prevents remote book assets from making requests.
      book.spine.hooks.content.register((doc: Document) => {
        const meta = createEl("meta");
        meta.setAttribute("http-equiv", "Content-Security-Policy");
        meta.setAttribute("content", "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob: data:; font-src blob: data:; media-src blob: data:");
        doc.head.prepend(meta);
      });
      if (this.area.clientWidth < 2 || this.area.clientHeight < 2) {
        await new Promise<void>((resolve) => {
          const resize = new ResizeObserver(() => {
            if (this.area.clientWidth > 1 && this.area.clientHeight > 1) { resize.disconnect(); resolve(); }
          });
          resize.observe(this.area);
          lifetime.register(() => { resize.disconnect(); resolve(); });
        });
        if (revision !== this.revision) return;
      }
      this.applyMargins();
      const options = {
        width: Math.max(1, this.area.clientWidth), height: Math.max(1, this.area.clientHeight),
        flow: "paginated", spread: this.pageLayout().columns === 2 ? "auto" : "none", minSpreadWidth: 0,
        allowScriptedContent: false, resizeOnOrientationChange: false, gap: this.pageLayout().gap,
      };
      const rendition = book.renderTo(this.area, options);
      this.rendition = rendition;
      rendition.hooks.content.register((contents: Contents) => {
        this.styleContents(contents);
        const pressed = (event: PointerEvent) => {
          this.tracker?.activity();
          if ((event.target as Element | null)?.closest("a[href]")) this.navigationPending = true;
        };
        const key = (event: KeyboardEvent) => this.onKey(event);
        contents.document.addEventListener("pointerdown", pressed, { passive: true });
        contents.document.addEventListener("keydown", key);
        const cleanup = () => {
          contents.document.removeEventListener("pointerdown", pressed);
          contents.document.removeEventListener("keydown", key);
        };
        const removeGestures = Platform.isMobile ? this.bindPageGestures(contents.document, contents.document, contents.window?.frameElement) : undefined;
        this.contentListeners.set(contents.document, () => { cleanup(); removeGestures?.(); });
      });
      rendition.hooks.unloaded.register(() => {
        for (const [document, cleanup] of this.contentListeners) {
          const connected = Array.from(this.area.querySelectorAll("iframe")).some((frame) => frame.contentDocument === document);
          if (!connected) { cleanup(); this.contentListeners.delete(document); }
        }
      });
      rendition.on("relocated", (location: Location) => {
        if (revision === this.revision) this.relocated(location);
      });
      // EPUB.js emits this error without settling the display promise.
      rendition.on("displayError", (error: Error) => {
        const pending = rendition as Rendition & { displaying?: { reject(reason: Error): void } };
        pending.displaying?.reject(error);
      });
      const saved = state.progress?.epub;
      let target: string | undefined;
      if (!this.interacted && validEpubLocation(saved)) {
        try { if (book.section(saved.cfi)) target = saved.cfi; }
        catch { /* A malformed saved location must not block opening. */ }
      }
      this.anchoredCfi = target ?? null;
      await rendition.display(target).catch(async (error: unknown) => {
        if (!target) throw error;
        this.anchoredCfi = null;
        new Notice("保存的位置已失效，尝试打开书籍开头");
        await rendition.display();
      });
      if (revision !== this.revision) return;
      message.remove();
      this.tracker = new ReadingTracker(() => this.isActive(), () => ({
        idleMs: this.plugin.readingIdleMs, dayEndMinutes: this.plugin.readingDayEndMinutes,
      }), async (session) => {
        await this.plugin.store.upsertReadingSession(file.path, session);
        this.plugin.refreshReadingLog();
      });
      if (target && saved?.cfi === this.anchoredCfi) this.location = saved;
      this.ready = true;
      if (rendition.location) this.relocated(rendition.location);
      this.tracker.activity();
      lifetime.registerInterval(window.setInterval(() => this.tracker?.tick(), 10_000));
      if (options.width !== this.area.clientWidth || options.height !== this.area.clientHeight) this.scheduleLayout();

      // Rendering and gestures are ready before indexing the rest of the book.
      this.indexPromise = book.locations.generate(1000).then(() => {
        if (revision !== this.revision || !book.locations.length()) return;
        this.indexReady = true;
        if (rendition.location) this.relocated(rendition.location);
        if (this.queuedLocation?.location.estimated) {
          const location = this.queuedLocation.location;
          location.percentage = book.locations.percentageFromCfi(location.cfi);
          delete location.estimated;
        }
      }).catch(() => { /* The reader can still resume by CFI and report an estimate. */ });
    } catch (error) {
      if (revision !== this.revision) return;
      this.ready = false;
      this.area.empty();
      const message = this.area.createDiv({ cls: "epub-pager-message", text: `无法打开 EPUB：${String(error instanceof Error ? error.message : error)}` });
      message.createEl("button", { text: "重试" }).addEventListener("click", () => void this.onLoadFile(file));
    }
  }

  private relocated(value: Location): void {
    if (!value?.start?.cfi || !this.book) return;
    this.currentHref = value.start.href;
    const nav = this.toc.find(({ item }) => item.href.split("#")[0] === this.currentHref)?.item;
    const navigating = this.navigationPending && !this.reformatting && this.isActive()
      && (value.start.cfi !== this.displayedCfi || this.navigationAnchor !== null);
    this.displayedCfi = value.start.cfi;
    const cfi = navigating ? this.navigationAnchor ?? value.start.cfi : this.anchoredCfi ?? value.start.cfi;
    const previous = this.location?.cfi === cfi ? this.location : null;
    const estimate = (value.start.index + (value.start.displayed.page - 1) / Math.max(1, value.start.displayed.total)) / this.sectionCount;
    const percentage = this.indexReady ? this.book.locations.percentageFromCfi(cfi)
      : previous?.percentage ?? (value.atEnd ? 1 : estimate);
    this.location = {
      cfi, percentage: Math.max(0, Math.min(1, percentage || 0)),
      chapter: nav?.label.trim() || `第 ${value.start.index + 1} 章`,
      ...(!this.indexReady && (!previous || previous.estimated) ? { estimated: true } : {}),
    };
    if (navigating || !this.anchoredCfi) this.anchoredCfi = this.location.cfi;
    this.tracker?.setLocation(this.location);
    this.status.textContent = `${this.location.estimated ? "≈" : ""}${(this.location.percentage * 100).toFixed(1)}%`;
    this.status.title = `${this.location.chapter} · ${value.start.displayed.page}/${value.start.displayed.total} 屏 · 阅读设置`;
    this.previousButton.disabled = value.atStart;
    this.nextButton.disabled = value.atEnd;
    // Reflow/open/background views must never publish a newer reading position.
    if (navigating) {
      this.navigationPending = false;
      this.navigationAnchor = null;
      this.queueProgress();
    }
  }

  turn(direction: -1 | 1): void {
    if (!this.ready || !this.rendition || this.moving || this.reformatting) return;
    if ((direction === 1 ? this.nextButton : this.previousButton).disabled) return;
    this.interacted = true;
    this.navigationPending = true;
    this.navigationAnchor = null;
    this.tracker?.activity();
    this.moving = true;
    void (direction === 1 ? this.rendition.next() : this.rendition.prev())
      .catch((error: unknown) => new Notice(`EPUB 翻页失败：${String(error)}`))
      .finally(() => { this.moving = false; });
  }

  private bindPageGestures(target: Document | HTMLElement, document: Document, frame?: Element | null): () => void {
    let press: { id: number; x: number; y: number; at: number } | null = null;
    const viewportX = (x: number) => (frame?.getBoundingClientRect().left ?? 0) + x;
    const start = (event: TouchEvent) => {
      press = null;
      if (event.touches.length !== 1 || !this.ready) return;
      const element = event.target as Element | null;
      if (element?.closest?.("a, button, input, textarea, select, audio, video, [contenteditable], .pager-reader-rail, .pager-reader-panel")
        || document.getSelection()?.isCollapsed === false) return;
      const touch = event.touches[0];
      const x = viewportX(touch.clientX);
      const width = this.containerEl.ownerDocument.documentElement.clientWidth;
      if (x < 22 || x > width - 22) return;
      press = { id: touch.identifier, x: touch.clientX, y: touch.clientY, at: event.timeStamp };
    };
    const end = (event: TouchEvent) => {
      const gesture = press;
      press = null;
      if (!gesture || document.getSelection()?.isCollapsed === false) return;
      const touch = Array.from(event.changedTouches).find((touch) => touch.identifier === gesture.id);
      if (!touch) return;
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      const duration = event.timeStamp - gesture.at;
      if (Math.abs(dx) >= 55 && Math.abs(dx) > Math.abs(dy) * 1.5 && duration < 750) {
        this.turn(dx < 0 ? 1 : -1);
      } else if (Math.hypot(dx, dy) < 10 && duration < 350) {
        const bounds = this.contentEl.getBoundingClientRect();
        const x = (viewportX(touch.clientX) - bounds.left) / bounds.width;
        if (x < 0.28) this.turn(-1);
        else if (x > 0.72) this.turn(1);
        else this.togglePanel();
      }
    };
    const cancel = () => { press = null; };
    const surface: EventTarget = target;
    surface.addEventListener("touchstart", start as EventListener, { passive: true });
    surface.addEventListener("touchend", end as EventListener, { passive: true });
    surface.addEventListener("touchcancel", cancel, { passive: true });
    return () => {
      surface.removeEventListener("touchstart", start as EventListener);
      surface.removeEventListener("touchend", end as EventListener);
      surface.removeEventListener("touchcancel", cancel);
    };
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      if (!this.panel.hidden) this.togglePanel();
      else if (this.focus) this.toggleFocusMode();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, button, select, [contenteditable='true']")) return;
    if (["ArrowLeft", "PageUp", "ArrowRight", "PageDown"].includes(event.key)) {
      event.preventDefault();
      this.turn(event.key === "ArrowLeft" || event.key === "PageUp" ? -1 : 1);
    }
  }

  private queueProgress(): void {
    if (this.file && this.location) this.queuedLocation = { path: this.file.path, location: { ...this.location } };
    if (this.progressTimer !== null) window.clearTimeout(this.progressTimer);
    this.progressTimer = window.setTimeout(() => {
      this.progressTimer = null;
      this.saveProgress();
    }, 500);
  }

  private saveProgress(): void {
    const queued = this.queuedLocation;
    this.queuedLocation = null;
    if (!queued) return;
    this.pendingProgress = this.plugin.store.recordEpubProgress(queued.path, queued.location);
    void this.pendingProgress.catch((error: unknown) => new Notice(`EPUB 进度保存失败：${String(error)}`));
  }

  private applyMargins(): void {
    this.contentEl.setCssProps({
      "--epub-margin-x": `${this.preferences.marginX}px`,
      "--epub-margin-top": `${this.preferences.marginTop}px`,
      "--epub-margin-bottom": `${this.preferences.marginBottom}px`,
      "--epub-page-max-width": `${this.pageLayout().maxWidth}px`,
    });
  }

  private pageLayout() {
    const preferences = Platform.isMobile ? { ...this.preferences, columnGap: DEFAULT_EPUB_PREFERENCES.columnGap } : this.preferences;
    return epubPageLayout(this.contentEl.clientWidth, preferences, Platform.isMobile);
  }

  private styleContents(contents: Contents): void {
    const style = getComputedStyle(this.contentEl);
    contents.css("color", this.containerEl.ownerDocument.body.classList.contains("theme-dark") ? "#dedbd4" : "#25221d", true);
    contents.css("background-color", style.backgroundColor, true);
    contents.css("font-size", `${this.preferences.fontSize}px`, true);
    contents.css("line-height", String(this.preferences.lineHeight), true);
    const family = this.preferences.font === "serif"
      ? '"Songti SC", "Noto Serif CJK SC", "Noto Serif CJK", "Source Han Serif SC", SimSun, serif'
      : '"PingFang SC", "Noto Sans CJK SC", "Noto Sans CJK", "Microsoft YaHei", sans-serif';
    void contents.addStylesheetCss(this.preferences.font === "original" ? "/* Original font */" : `@layer pager-font {
      :where(body, body :is(p, div, li, blockquote, span, a, em, strong, b, i, font, dt, dd, td, th, h1, h2, h3, h4, h5, h6)) {
        font-family: ${family} !important;
      }
    }`, "pager-font");
    void contents.addStylesheetRules({
      ...(Platform.isMobile ? { "html, body, body *": { "touch-action": "pan-y pinch-zoom" } } : {}),
      "html, body": { margin: "0 !important", "padding-block": "0 !important", "max-width": "none !important", "-webkit-text-size-adjust": "100%", "text-size-adjust": "100%" },
      "body": { "padding-inline": `${this.pageLayout().gap / 2}px !important` },
      "p, li, blockquote": { color: "inherit !important", "font-size": "inherit !important", "line-height": "inherit !important",
        "text-align": "justify !important", "overflow-wrap": "break-word", hyphens: "auto", orphans: "2", widows: "2" },
      "p": { "margin-block": `${this.preferences.paragraphGap}em !important` },
      "img, svg, video": { "max-width": "100% !important", "object-fit": "contain" },
    }, "pager-layout");
  }

  private scheduleLayout(): void {
    if (!this.ready || !this.rendition) return;
    this.reformatting = true;
    this.applyMargins();
    if (this.layoutTimer !== null) window.clearTimeout(this.layoutTimer);
    this.layoutTimer = window.setTimeout(() => {
      this.layoutTimer = null;
      void this.relayout();
    }, 150);
  }

  private async relayout(): Promise<void> {
    const rendition = this.rendition;
    if (!rendition || this.area.clientWidth < 1 || this.area.clientHeight < 1) { this.reformatting = false; return; }
    const target = this.anchoredCfi;
    try {
      const layout = this.pageLayout();
      // The manager copies options at construction; update its gap before recalculating.
      const managed = rendition as Rendition & { manager?: { settings: { gap?: number } } };
      if (managed.manager) managed.manager.settings.gap = layout.gap;
      rendition.spread(layout.columns === 2 ? "auto" : "none", 0);
      // epub.js's public declarations omit the third resize argument supported by the engine.
      (rendition as Rendition & { resize(width: number, height: number, cfi?: string): void })
        .resize(this.area.clientWidth, this.area.clientHeight, target ?? undefined);
      // epub.js returns an array here despite its declaration saying Contents.
      const contents = rendition.getContents() as unknown as Contents[];
      for (const content of contents) this.styleContents(content);
      if (target) await rendition.display(target);
    } catch (error) { new Notice(`EPUB 排版失败：${String(error)}`); }
    finally {
      if (this.rendition === rendition && this.layoutTimer === null) {
        this.reformatting = false;
        const jump = this.queuedJump;
        this.queuedJump = null;
        if (jump) this.jump(jump);
      }
    }
  }

  private togglePanel(): void {
    this.panel.hidden = !this.panel.hidden;
    this.status.setAttribute("aria-expanded", String(!this.panel.hidden));
  }

  private renderPanel(): void {
    this.panelBody.empty();
    const actions = this.panelBody.createDiv("pager-reader-actions");
    icon(actions, "list-tree", "目录", () => this.openToc());
    icon(actions, "bookmark-plus", "添加书签", () => void this.addBookmark());
    icon(actions, "book-marked", "书签列表", () => void this.showBookmarks());
    icon(actions, "file-text", "打开书籍日志", () => { if (this.file) void this.plugin.openReadingNoteForPdf(this.file.path); });
    icon(actions, "bar-chart-3", "阅读日志", () => void this.plugin.openReadingLog());
    const focus = icon(actions, "maximize-2", "进入专注模式", () => this.toggleFocusMode());
    setFocusButton(focus, this.focus);
    if (!Platform.isMobile) {
      const spreads = this.panelBody.createDiv({ cls: "epub-pager-fonts", attr: { role: "group", "aria-label": "页面栏数" } });
      for (const [value, label] of [["auto", "自动"], ["single", "单栏"], ["double", "双栏"]] as const) {
        const choice = spreads.createEl("button", { text: label, attr: { "aria-label": label, "aria-pressed": String(this.preferences.spread === value) } });
        choice.addEventListener("click", () => { this.preferences.spread = value; this.savePreferences(); this.renderPanel(); });
      }
    }
    const options: Array<[keyof Omit<EpubPreferences, "font" | "spread">, string, number, number, number]> = [
      ["fontSize", "字号", 12, 40, 1], ["lineHeight", "行距", 1.1, 2.5, 0.1],
      ["paragraphGap", "段间距", 0, 2, 0.1], ["marginX", "左右边距", 0, 64, 2],
      ["marginTop", "顶部留白", 0, 64, 2], ["marginBottom", "底部留白", 0, 64, 2],
    ];
    if (!Platform.isMobile) options.push(["columnGap", "双栏中缝", 16, 96, 2]);
    for (const [key, label, min, max, step] of options) {
      const row = this.panelBody.createEl("label", { cls: "epub-pager-option" });
      row.createSpan({ text: label });
      const input = row.createEl("input", { type: "range", attr: { min: String(min), max: String(max), step: String(step), "aria-label": label } });
      input.value = String(this.preferences[key]);
      const value = row.createEl("output", { text: String(this.preferences[key]) });
      input.addEventListener("input", () => {
        this.preferences[key] = Number(input.value);
        value.textContent = input.value;
        this.savePreferences();
      });
    }
    const fonts = this.panelBody.createDiv("epub-pager-fonts");
    for (const [value, label] of [["original", "原字体"], ["serif", "宋体类"], ["sans-serif", "黑体类"]] as const) {
      const choice = fonts.createEl("button", { text: label, attr: { "aria-pressed": String(this.preferences.font === value) } });
      choice.addEventListener("click", () => {
        this.preferences.font = value;
        this.savePreferences();
        this.renderPanel();
      });
    }
  }

  private openToc(): void {
    const book = this.book;
    if (!this.ready || !book) { new Notice("正在加载电子书"); return; }
    if (!this.toc.length) { new Notice("这本书没有目录"); return; }
    const modal = new Modal(this.app);
    modal.setTitle("目录");
    const search = modal.contentEl.createEl("input", { type: "search", attr: { placeholder: "搜索章节", "aria-label": "搜索章节" } });
    const list = modal.contentEl.createDiv("epub-pager-toc-list");
    const documents = new Map<string, Promise<Document>>();
    const rows = this.toc.map(({ item, depth }) => {
      const label = item.label.trim();
      const row = list.createEl("button", { cls: "epub-pager-toc-row", attr: { type: "button" } });
      row.setCssProps({ "--epub-toc-indent": `${Math.min(depth, 5) * 12}px` });
      const chapter = row.createSpan("epub-pager-toc-chapter");
      chapter.createSpan({ cls: "epub-pager-toc-dot", attr: { "aria-hidden": "true" } });
      chapter.createSpan({ text: label });
      const percent = row.createSpan("epub-pager-toc-percent");
      const [href, fragment] = item.href.split("#");
      if (!fragment && href === this.currentHref) row.setAttribute("aria-current", "location");
      let target = Promise.resolve(item.href);
      const section = book.section(href);
      if (section) {
        const start = `epubcfi(${section.cfiBase}!/4)`;
        const show = (cfi: string) => {
          if (!this.indexReady) {
            percent.textContent = `≈${(section.index / this.sectionCount * 100).toFixed(1)}%`;
          } else {
            const value = book.locations.percentageFromCfi(cfi);
            if (Number.isFinite(value)) percent.textContent = `${(value * 100).toFixed(1)}%`;
          }
        };
        show(start);
        if (fragment) {
          const document = documents.get(href) ?? Promise.resolve(section.load(book.load.bind(book)));
          documents.set(href, document);
          target = document.then((root) => {
            if (this.book !== book) return item.href;
            const anchor = (root.ownerDocument ?? root).getElementById(decodeURIComponent(fragment));
            return anchor ? section.cfiFromElement(anchor) : href;
          }).catch(() => item.href);
        }
        void Promise.all([target, this.indexPromise]).then(([destination]) => {
          if (this.book === book && row.isConnected) show(destination.startsWith("epubcfi(") ? destination : start);
        });
      }
      row.addEventListener("click", () => {
        modal.close();
        void target.then((destination) => { if (this.book === book) this.jump(destination); });
      });
      return { row, label: label.toLocaleLowerCase() };
    });
    search.addEventListener("input", () => {
      const query = search.value.trim().toLocaleLowerCase();
      for (const { row, label } of rows) row.hidden = !label.includes(query);
    });
    modal.open();
  }

  private savePreferences(): void {
    this.app.saveLocalStorage(PREFERENCES_KEY, this.preferences);
    this.applyMargins();
    this.scheduleLayout();
  }

  private jump(target: string): void {
    const rendition = this.rendition;
    if (!this.ready || !rendition) return;
    if (this.reformatting) { this.queuedJump = target; return; }
    this.interacted = true;
    this.navigationPending = false;
    this.tracker?.activity();
    this.panel.hidden = true;
    this.status.setAttribute("aria-expanded", "false");
    void rendition.display(target).then(() => {
      if (this.rendition !== rendition) return;
      this.navigationAnchor = target.startsWith("epubcfi(") ? target : null;
      this.navigationPending = true;
    }).catch((error: unknown) => new Notice(`EPUB 跳转失败：${String(error)}`));
  }

  async addBookmark(): Promise<void> {
    if (!this.ready || !this.location || !this.file) return;
    await this.plugin.store.addEpubBookmark(this.file.path, this.location);
    new Notice("已添加书签");
  }

  private async showBookmarks(): Promise<void> {
    if (!this.file) return;
    const state = await this.plugin.store.load(this.file.path);
    const bookmarks = state.bookmarks.filter((item) => validEpubLocation(item.epub));
    if (!bookmarks.length) { new Notice("还没有书签"); return; }
    new EpubChoiceModal<Bookmark>(this.app, "搜索书签", bookmarks, (item) => item.label,
      (item) => { if (item.epub) this.jump(item.epub.cfi); }).open();
  }

  toggleFocusMode(): void {
    this.focus = !this.focus;
    this.contentEl.toggleClass("is-focus", this.focus);
    this.plugin.syncFocusMode();
    this.renderPanel();
  }

  isFocusModeEnabled(): boolean { return this.focus; }
  focusDocument(): Document { return this.containerEl.ownerDocument; }
  applyFocusMode(active: boolean): void { this.containerEl.toggleClass("pdf-pager-focus-active", active); }

  private syncFocus(): void {
    if (!this.isActive()) {
      // Commit a pending user navigation before losing focus, using its captured position.
      if (this.progressTimer !== null) {
        window.clearTimeout(this.progressTimer);
        this.progressTimer = null;
        this.saveProgress();
      }
      this.tracker?.pause();
    } else this.tracker?.activity();
    this.plugin.syncFocusMode();
  }

  async flushReading(): Promise<void> { await this.tracker?.flush(); }

  async flushProgress(): Promise<void> {
    if (this.progressTimer !== null) { window.clearTimeout(this.progressTimer); this.progressTimer = null; }
    this.saveProgress();
    await this.pendingProgress;
  }

  async onUnloadFile(): Promise<void> { await this.closeBook(); }

  private async closeBook(invalidate = true): Promise<void> {
    if (invalidate) ++this.revision;
    if (this.progressTimer !== null) { window.clearTimeout(this.progressTimer); this.progressTimer = null; this.saveProgress(); }
    this.ready = false;
    const tracker = this.tracker;
    tracker?.pause();
    const progress = this.pendingProgress;
    this.tracker = null;
    if (this.layoutTimer !== null) window.clearTimeout(this.layoutTimer);
    this.layoutTimer = null;
    this.reformatting = false;
    if (this.lifetime) this.removeChild(this.lifetime);
    this.lifetime = null;
    for (const cleanup of this.contentListeners.values()) cleanup();
    this.contentListeners.clear();
    this.rendition?.destroy();
    this.rendition = null;
    this.book?.destroy();
    this.book = null;
    this.focus = false;
    this.applyFocusMode(false);
    this.plugin.syncFocusMode();
    await tracker?.flush().catch((error: unknown) => new Notice(`EPUB 阅读时间保存失败：${String(error)}`));
    await progress.catch(() => undefined);
  }

  async onClose(): Promise<void> {
    await this.closeBook();
    this.applyFocusMode(false);
    this.focus = false;
    this.plugin.syncFocusMode();
  }
}
