import { Component, FileView, FuzzySuggestModal, Notice, setIcon, type TFile, type WorkspaceLeaf } from "obsidian";
import { Book, type Contents, type Location, type NavItem, type Rendition } from "epubjs";
import type PdfPagerPlugin from "./main";
import { normalizeEpubPreferences, validEpubLocation, type EpubPreferences } from "./epub-state";
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

function flattenToc(items: NavItem[]): NavItem[] {
  return items.flatMap((item) => [item, ...flattenToc(item.subitems ?? [])]);
}

export class EpubReaderView extends FileView {
  private book: Book | null = null;
  private rendition: Rendition | null = null;
  private lifetime: Component | null = null;
  private revision = 0;
  private ready = false;
  private reformatting = false;
  private moving = false;
  private interacted = false;
  private navigationPending = false;
  private focus = false;
  private location: EpubLocation | null = null;
  private tracker: ReadingTracker | null = null;
  private toc: NavItem[] = [];
  private preferences: EpubPreferences;
  private area!: HTMLElement;
  private rail!: HTMLElement;
  private panel!: HTMLElement;
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
    this.interacted = false;
    this.navigationPending = false;
    this.anchoredCfi = null;
    this.area = this.contentEl.createDiv("epub-pager-area");
    const message = this.area.createDiv({ cls: "epub-pager-message", text: "正在打开 EPUB…" });
    this.rail = this.contentEl.createDiv("epub-pager-controls");
    this.previousButton = icon(this.rail, "chevron-left", "上一屏", () => this.turn(-1));
    this.status = this.rail.createEl("button", { text: "…", attr: { title: "阅读设置", "aria-label": "展开阅读设置", "aria-expanded": "false" } });
    this.status.addEventListener("click", () => this.togglePanel());
    this.nextButton = icon(this.rail, "chevron-right", "下一屏", () => this.turn(1));
    this.panel = this.contentEl.createDiv("epub-pager-panel");
    this.panel.hidden = true;
    this.renderPanel();
    this.applyMargins();
    const activity = () => this.tracker?.activity();
    lifetime.registerDomEvent(this.area, "pointerdown", activity);
    lifetime.registerDomEvent(this.contentEl, "keydown", (event) => this.onKey(event));
    lifetime.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncFocus()));
    lifetime.registerDomEvent(this.containerEl.ownerDocument, "visibilitychange", () => this.syncFocus());
    const resize = new ResizeObserver(() => this.scheduleLayout());
    resize.observe(this.area);
    lifetime.register(() => resize.disconnect());
    const theme = new MutationObserver(() => this.scheduleLayout());
    theme.observe(this.containerEl.ownerDocument.body, { attributes: true, attributeFilter: ["class", "style"] });
    lifetime.register(() => theme.disconnect());
    try {
      const [data, state] = await Promise.all([this.app.vault.readBinary(file), this.plugin.store.load(file.path)]);
      if (revision !== this.revision) return;
      const book = new Book({ replacements: "blobUrl" });
      this.book = book;
      await book.open(data, "binary");
      await book.ready;
      if (revision !== this.revision) return;
      this.toc = flattenToc(book.navigation.toc);
      // The iframe keeps scripts disabled. CSP also prevents remote book assets from making requests.
      book.spine.hooks.content.register((doc: Document) => {
        const meta = createEl("meta");
        meta.setAttribute("http-equiv", "Content-Security-Policy");
        meta.setAttribute("content", "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob: data:; font-src blob: data:; media-src blob: data:");
        doc.head.prepend(meta);
      });
      message.remove();
      const options = {
        width: Math.max(1, this.area.clientWidth), height: Math.max(1, this.area.clientHeight),
        flow: "paginated", spread: "none", allowScriptedContent: false,
        resizeOnOrientationChange: false, gap: 0,
      };
      const rendition = book.renderTo(this.area, options);
      // Zero column gap; outer insets are the only adjustable page margins.
      this.rendition = rendition;
      rendition.hooks.content.register((contents: Contents) => {
        this.styleContents(contents);
        const pressed = (event: PointerEvent) => {
          activity();
          if ((event.target as Element | null)?.closest("a[href]")) this.navigationPending = true;
        };
        const key = (event: KeyboardEvent) => this.onKey(event);
        contents.document.addEventListener("pointerdown", pressed, { passive: true });
        contents.document.addEventListener("keydown", key);
        const cleanup = () => {
          contents.document.removeEventListener("pointerdown", pressed);
          contents.document.removeEventListener("keydown", key);
        };
        this.contentListeners.set(contents.document, cleanup);
      });
      rendition.hooks.unloaded.register(() => {
        for (const [document, cleanup] of this.contentListeners) {
          const connected = Array.from(this.area.querySelectorAll("iframe")).some((frame) => frame.contentDocument === document);
          if (!connected) { cleanup(); this.contentListeners.delete(document); }
        }
      });
      rendition.on("relocated", (location: Location) => this.relocated(location));
      rendition.on("displayError", (error: Error) => new Notice(`EPUB 显示失败：${error.message}`));
      const saved = state.progress?.epub;
      const target = !this.interacted && validEpubLocation(saved) ? saved.cfi : undefined;
      await rendition.display(target).catch(async (error: unknown) => {
        if (!target) throw error;
        new Notice("保存的位置已失效，已打开书籍开头");
        await rendition.display();
      });
      if (revision !== this.revision) return;
      this.tracker = new ReadingTracker(() => this.isActive(), () => ({
        idleMs: this.plugin.readingIdleMs, dayEndMinutes: this.plugin.readingDayEndMinutes,
      }), async (session) => {
        await this.plugin.store.upsertReadingSession(file.path, session);
        this.plugin.refreshReadingLog();
      });
      // Generate text-based progress positions, independent of viewport and font size.
      await book.locations.generate(1000);
      if (revision !== this.revision) return;
      this.ready = true;
      if (rendition.location) this.relocated(rendition.location);
      this.tracker.activity();
      lifetime.registerInterval(window.setInterval(() => this.tracker?.tick(), 10_000));
      this.scheduleLayout();
    } catch (error) {
      if (revision !== this.revision) return;
      this.ready = false;
      this.area.empty();
      this.area.createDiv({ cls: "epub-pager-message", text: `无法打开 EPUB：${String(error instanceof Error ? error.message : error)}` });
    }
  }

  private relocated(value: Location): void {
    if (!value?.start?.cfi || !this.book) return;
    const nav = this.toc.find((item) => item.href.split("#")[0] === value.start.href.split("#")[0]);
    const navigating = this.navigationPending && !this.reformatting && this.isActive();
    const cfi = navigating || !this.anchoredCfi ? value.start.cfi : this.anchoredCfi;
    const percentage = this.book.locations.length() ? this.book.locations.percentageFromCfi(cfi) : 0;
    this.location = {
      cfi, percentage: Math.max(0, Math.min(1, percentage || 0)),
      chapter: nav?.label.trim() || `第 ${value.start.index + 1} 章`,
    };
    if (navigating || !this.anchoredCfi) this.anchoredCfi = this.location.cfi;
    this.tracker?.setLocation(this.location);
    this.status.textContent = `${(this.location.percentage * 100).toFixed(1)}%`;
    this.status.title = `${this.location.chapter} · ${value.start.displayed.page}/${value.start.displayed.total} 屏 · 阅读设置`;
    this.previousButton.disabled = value.atStart;
    this.nextButton.disabled = value.atEnd;
    // Reflow/open/background views must never publish a newer reading position.
    if (navigating) {
      this.navigationPending = false;
      this.queueProgress();
    }
  }

  turn(direction: -1 | 1): void {
    if (!this.ready || !this.rendition || this.moving || this.reformatting) return;
    this.interacted = true;
    this.navigationPending = true;
    this.tracker?.activity();
    this.moving = true;
    void (direction === 1 ? this.rendition.next() : this.rendition.prev())
      .catch((error: unknown) => new Notice(`EPUB 翻页失败：${String(error)}`))
      .finally(() => { this.moving = false; });
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
      "--epub-margin-x": `${this.preferences.marginX}px`, "--epub-margin-y": `${this.preferences.marginY}px`,
    });
  }

  private styleContents(contents: Contents): void {
    const style = getComputedStyle(this.contentEl);
    contents.css("color", style.color, true);
    contents.css("background-color", style.backgroundColor, true);
    contents.css("font-size", `${this.preferences.fontSize}px`, true);
    contents.css("line-height", String(this.preferences.lineHeight), true);
    if (this.preferences.font !== "original") contents.css("font-family", this.preferences.font, true);
    else contents.css("font-family", "", true);
    void contents.addStylesheetRules({
      "html, body": { margin: "0 !important", padding: "0 !important", "max-width": "none !important" },
      "p": { "font-size": "inherit !important", "line-height": "inherit !important", "margin-block": `${this.preferences.paragraphGap}em !important` },
      "img, svg, video": { "max-width": "100% !important", "object-fit": "contain" },
    }, "pager-layout");
  }

  private scheduleLayout(): void {
    if (!this.ready || !this.rendition) return;
    this.reformatting = true;
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
      // epub.js's public declarations omit the third resize argument supported by the engine.
      (rendition as Rendition & { resize(width: number, height: number, cfi?: string): void })
        .resize(this.area.clientWidth, this.area.clientHeight, target ?? undefined);
      // epub.js returns an array here despite its declaration saying Contents.
      const contents = rendition.getContents() as unknown as Contents[];
      for (const content of contents) this.styleContents(content);
      if (target) await rendition.display(target);
    } catch (error) { new Notice(`EPUB 排版失败：${String(error)}`); }
    finally { this.reformatting = false; }
  }

  private togglePanel(): void {
    this.panel.hidden = !this.panel.hidden;
    this.status.setAttribute("aria-expanded", String(!this.panel.hidden));
  }

  private renderPanel(): void {
    this.panel.empty();
    const actions = this.panel.createDiv("epub-pager-actions");
    icon(actions, "list-tree", "目录", () => {
      new EpubChoiceModal(this.app, "搜索章节", this.toc, (item) => item.label,
        (item) => this.jump(item.href)).open();
    });
    icon(actions, "bookmark-plus", "添加书签", () => void this.addBookmark());
    icon(actions, "book-marked", "书签列表", () => void this.showBookmarks());
    icon(actions, "file-text", "打开书籍日志", () => { if (this.file) void this.plugin.openReadingNoteForPdf(this.file.path); });
    icon(actions, "bar-chart-3", "阅读日志", () => void this.plugin.openReadingLog());
    const focus = icon(actions, "maximize-2", "切换专注模式", () => this.toggleFocusMode());
    focus.setAttribute("aria-pressed", String(this.focus));
    const close = icon(actions, "x", "关闭阅读设置", () => this.togglePanel());
    close.addClass("epub-pager-panel-close");
    const options: Array<[keyof Omit<EpubPreferences, "font">, string, number, number, number]> = [
      ["fontSize", "字号", 12, 40, 1], ["lineHeight", "行距", 1.1, 2.5, 0.1],
      ["paragraphGap", "段间距", 0, 2, 0.1], ["marginX", "左右边距", 0, 64, 2], ["marginY", "上下边距", 0, 64, 2],
    ];
    for (const [key, label, min, max, step] of options) {
      const row = this.panel.createEl("label", { cls: "epub-pager-option" });
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
    const fonts = this.panel.createDiv("epub-pager-fonts");
    for (const [value, label] of [["original", "原字体"], ["serif", "宋体类"], ["sans-serif", "黑体类"]] as const) {
      const choice = fonts.createEl("button", { text: label, attr: { "aria-pressed": String(this.preferences.font === value) } });
      choice.addEventListener("click", () => {
        this.preferences.font = value;
        this.savePreferences();
        this.renderPanel();
      });
    }
  }

  private savePreferences(): void {
    this.app.saveLocalStorage(PREFERENCES_KEY, this.preferences);
    this.applyMargins();
    this.scheduleLayout();
  }

  private jump(target: string): void {
    if (!this.ready || !this.rendition) return;
    this.interacted = true;
    this.navigationPending = true;
    this.tracker?.activity();
    this.panel.hidden = true;
    this.status.setAttribute("aria-expanded", "false");
    void this.rendition.display(target).catch((error: unknown) => new Notice(`EPUB 跳转失败：${String(error)}`));
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
