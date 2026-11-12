// Synthetic browser fixture only. Never loads a vault or a native Obsidian window.
export class Component {
  load(): void {}
  cleanups: Array<() => void> = [];
  children = new Set<Component>();
  addChild<T extends Component>(child: T): T { this.children.add(child); return child; }
  removeChild(child: Component): void { child.unload(); this.children.delete(child); }
  register(fn: () => void): void { this.cleanups.push(fn); }
  registerDomEvent(target: EventTarget, event: string, fn: EventListener): void {
    target.addEventListener(event, fn); this.register(() => target.removeEventListener(event, fn));
  }
  registerInterval(id: number): void { this.register(() => clearInterval(id)); }
  registerEvent(ref: { off: () => void }): void { this.register(() => ref.off()); }
  unload(): void { for (const child of this.children) child.unload(); for (const fn of this.cleanups.splice(0)) fn(); }
}
export class FileView extends Component {
  app: unknown;
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  file: unknown;
  constructor(public leaf: { app: unknown }) {
    super(); this.app = leaf.app;
    this.containerEl = document.querySelector("#host")!;
    this.contentEl = this.containerEl.createDiv();
    this.contentEl.classList.add("view-content");
  }
  addAction(_icon: string, label: string, callback: () => void): HTMLElement {
    const action = this.containerEl.createEl("button", { attr: { "aria-label": label } });
    action.addEventListener("click", callback);
    return action;
  }
}
export class ItemView extends FileView {}
export class TFile {}
export class FuzzySuggestModal { setPlaceholder(): void {} open(): void {} }
export const Platform = { isMobile: false };
export let fontRequests = 0;
export async function requestUrl({ url }: { url: string }): Promise<{ arrayBuffer: ArrayBuffer }> {
  if (!url.endsWith("/NotoSerifCJKsc-Regular.otf")) throw new Error("Unexpected URL");
  fontRequests++;
  const response = await fetch("/fixture.otf");
  if (!response.ok) throw new Error("No font fixture");
  return { arrayBuffer: await response.arrayBuffer() };
}
export class Notice { constructor(message: string) { (window as unknown as { notices: string[] }).notices.push(message); } }
export function setIcon(element: HTMLElement, name: string): void { element.dataset.icon = name; element.textContent = name === "chevron-left" ? "‹" : name === "chevron-right" ? "›" : "·"; }

const prototype = HTMLElement.prototype as unknown as Record<string, unknown>;
prototype.createEl = function(this: HTMLElement, tag: string, options: Record<string, unknown> = {}) {
  const element = document.createElement(tag);
  if (options.cls) element.className = String(options.cls);
  if (options.text) element.textContent = String(options.text);
  if (options.type) element.setAttribute("type", String(options.type));
  for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, String(value));
  this.append(element); return element;
};
prototype.createDiv = function(this: HTMLElement, options: unknown = {}) { return this.createEl("div", typeof options === "string" ? { cls: options } : options); };
prototype.createSpan = function(this: HTMLElement, options: unknown = {}) { return this.createEl("span", typeof options === "string" ? { cls: options } : options); };
prototype.empty = function(this: HTMLElement) { this.replaceChildren(); };
prototype.addClass = function(this: HTMLElement, ...classes: string[]) { this.classList.add(...classes); };
prototype.hasClass = function(this: HTMLElement, cls: string) { return this.classList.contains(cls); };
prototype.removeClass = function(this: HTMLElement, ...classes: string[]) { this.classList.remove(...classes); };
prototype.toggleClass = function(this: HTMLElement, cls: string, value: boolean) { this.classList.toggle(cls, value); };
prototype.setCssProps = function(this: HTMLElement, values: Record<string, string>) { for (const [key, value] of Object.entries(values)) this.style.setProperty(key, value); };
(window as unknown as Record<string, unknown>).createEl = (tag: string) => document.createElement(tag);

export class Modal {
  contentEl = document.createElement("div");
  constructor(_app: unknown) { this.contentEl.style.cssText = "position:fixed;inset:12px;z-index:200;background:white"; }
  setTitle(title: string): void { this.contentEl.setAttribute("aria-label", title); }
  open(): void { document.body.append(this.contentEl); }
  close(): void { this.contentEl.remove(); }
}
