import { Modal, setIcon, type App, type FileView } from "obsidian";
import type { Bookmark, ReadingState } from "./reading-state";

export interface PagerActions {
  previous(): void;
  next(): void;
  goTo(page: number): void;
  addBookmark(): void;
  deleteBookmark(bookmark: Bookmark): void;
  fit(mode: "page-fit" | "page-width"): void;
  width(factor: number): void;
}

function button(parent: HTMLElement, icon: string, label: string, callback: () => void): HTMLButtonElement {
  const element = parent.createEl("button", { cls: "pdf-pager-button", attr: { "aria-label": label, title: label, type: "button" } });
  setIcon(element, icon);
  element.addEventListener("click", (event) => { event.stopPropagation(); callback(); });
  return element;
}

class DeleteBookmarkModal extends Modal {
  constructor(app: App, bookmark: Bookmark, onDelete: () => void) {
    super(app);
    this.setTitle("删除书签");
    this.contentEl.createEl("p", { text: `删除“${bookmark.label}”？PDF 文件不会改变。` });
    const actions = this.contentEl.createDiv("pdf-pager-confirm-actions");
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const remove = actions.createEl("button", { cls: "mod-warning", text: "删除书签" });
    remove.addEventListener("click", () => { this.close(); onDelete(); });
  }
}

export class PagerUi {
  readonly bar: HTMLDivElement;
  private panel: HTMLDivElement;
  private pageInput: HTMLInputElement;
  private total: HTMLSpanElement;
  private progress: HTMLSpanElement;
  private prev: HTMLButtonElement;
  private next: HTMLButtonElement;
  private bookmark: HTMLButtonElement;
  private listButton: HTMLButtonElement;
  private widthButton: HTMLButtonElement;
  private headerAction: HTMLElement;
  private state: ReadingState = { bookmarks: [] };
  private page = 1;
  private pageCount = 1;
  private path = "";
  private panelMode: "bookmarks" | "width" | null = null;
  private factor = 1;
  private widthSlider: HTMLInputElement | null = null;
  private widthLabel: HTMLSpanElement | null = null;

  constructor(private app: App, private view: FileView, private actions: PagerActions) {
    view.containerEl.addClass("pdf-pager-host");
    this.bar = view.containerEl.createDiv("pdf-pager-bar");
    this.bar.addEventListener("pointerdown", (event) => event.stopPropagation());
    this.bar.addEventListener("keydown", (event) => event.stopPropagation());
    this.prev = button(this.bar, "chevron-left", "上一页", () => actions.previous());
    const readout = this.bar.createDiv("pdf-pager-readout");
    this.pageInput = readout.createEl("input", { type: "number", attr: { min: "1", inputmode: "numeric", "aria-label": "PDF 页码" } });
    this.pageInput.addEventListener("change", () => actions.goTo(Number(this.pageInput.value)));
    this.total = readout.createSpan({ text: "/1" });
    this.progress = readout.createSpan({ cls: "pdf-pager-progress", text: "0%" });
    this.next = button(this.bar, "chevron-right", "下一页", () => actions.next());
    this.bookmark = button(this.bar, "bookmark-plus", "给当前页加书签", () => actions.addBookmark());
    this.listButton = button(this.bar, "list", "书签列表", () => this.togglePanel("bookmarks"));
    this.widthButton = button(this.bar, "expand", "调整页面宽度", () => this.togglePanel("width"));
    this.panel = view.containerEl.createDiv("pdf-pager-panel");
    this.panel.hidden = true;
    this.panel.addEventListener("pointerdown", (event) => event.stopPropagation());
    this.panel.addEventListener("click", (event) => event.stopPropagation());
    this.panel.addEventListener("keydown", (event) => event.stopPropagation());
    this.headerAction = view.addAction("book-open", "显示或隐藏 PDF 翻页控制", () => this.toggleBar());
    this.render();
  }

  setFile(path: string, state: ReadingState, pageCount: number): void {
    this.path = path;
    this.state = state;
    this.pageCount = Math.max(1, pageCount);
    this.panelMode = null;
    this.panel.hidden = true;
    this.render();
  }

  update(page: number, pageCount: number, state: ReadingState): void {
    this.page = page;
    this.pageCount = Math.max(1, pageCount);
    this.state = state;
    this.render();
  }

  setFactor(factor: number): void {
    this.factor = factor;
    if (this.widthSlider) this.widthSlider.value = String(Math.round(factor * 100));
    if (this.widthLabel) this.widthLabel.textContent = `${Math.round(factor * 100)}%`;
  }

  toggleBar(): void {
    this.bar.classList.toggle("is-hidden");
    if (this.bar.classList.contains("is-hidden")) {
      this.panelMode = null;
      this.panel.hidden = true;
    }
  }

  private togglePanel(mode: "bookmarks" | "width"): void {
    this.panelMode = this.panelMode === mode ? null : mode;
    this.panel.hidden = this.panelMode === null;
    this.renderPanel();
  }

  private render(): void {
    this.pageInput.value = String(this.page);
    this.pageInput.max = String(this.pageCount);
    this.total.textContent = `/${this.pageCount}`;
    this.progress.textContent = `${Math.round((this.page / this.pageCount) * 100)}%`;
    this.prev.disabled = this.page <= 1;
    this.next.disabled = this.page >= this.pageCount;
    const already = this.state.bookmarks.some((item) => item.page === this.page);
    this.bookmark.disabled = already;
    this.bookmark.setAttribute("aria-label", already ? "当前页已有书签" : "给当前页加书签");
    this.listButton.setAttribute("aria-label", `书签列表，${this.state.bookmarks.length} 个`);
    if (this.panelMode === "bookmarks") this.renderPanel();
  }

  private renderPanel(): void {
    this.panel.empty();
    this.widthSlider = null;
    this.widthLabel = null;
    if (this.panelMode === "bookmarks") {
      const heading = this.panel.createDiv("pdf-pager-panel-heading");
      heading.createSpan({ text: "书签" });
      button(heading, "bookmark-plus", "给当前页加书签", () => this.actions.addBookmark());
      if (this.state.bookmarks.length === 0) {
        this.panel.createDiv({ cls: "pdf-pager-empty", text: "还没有书签" });
      }
      for (const item of this.state.bookmarks) {
        const row = this.panel.createDiv("pdf-pager-bookmark-row");
        const jump = row.createEl("button", { cls: "pdf-pager-bookmark-jump", text: item.label });
        jump.addEventListener("click", () => { this.actions.goTo(item.page); this.togglePanel("bookmarks"); });
        button(row, "trash-2", `删除${item.label}`, () => {
          new DeleteBookmarkModal(this.app, item, () => this.actions.deleteBookmark(item)).open();
        });
      }
      return;
    }
    if (this.panelMode === "width") {
      this.panel.createDiv({ cls: "pdf-pager-panel-heading", text: "页面宽度" });
      const row = this.panel.createDiv("pdf-pager-width-row");
      row.createSpan({ text: "窄" });
      const slider = row.createEl("input", { type: "range", attr: { min: "70", max: "160", step: "5", value: String(Math.round(this.factor * 100)), "aria-label": "页面显示宽度" } });
      const value = row.createSpan({ text: `${Math.round(this.factor * 100)}%` });
      this.widthSlider = slider;
      this.widthLabel = value;
      slider.addEventListener("input", () => { value.textContent = `${slider.value}%`; this.actions.width(Number(slider.value) / 100); });
      row.createSpan({ text: "宽" });
      const fits = this.panel.createDiv("pdf-pager-fit-buttons");
      const whole = fits.createEl("button", { text: "适合整页" });
      whole.addEventListener("click", () => this.actions.fit("page-fit"));
      const wide = fits.createEl("button", { text: "适合宽度" });
      wide.addEventListener("click", () => this.actions.fit("page-width"));
      this.panel.createDiv({ cls: "pdf-pager-hint", text: "仅调整显示，不修改 PDF。捏合缩放仍可用。" });
    }
  }

  destroy(): void {
    this.headerAction.remove();
    this.bar.remove();
    this.panel.remove();
    this.view.containerEl.removeClass("pdf-pager-host");
  }
}
