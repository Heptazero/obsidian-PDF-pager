import { setIcon, type Component, type Workspace } from "obsidian";

export function watchReaderToolbar(lifetime: Component, host: HTMLElement, workspace: Workspace, keepTop = false): void {
  const document = host.ownerDocument;
  const selector = ".mobile-navbar, .mobile-toolbar";
  let bars: HTMLElement[] = [];
  let inset = -1;
  let screenTop: number | undefined;
  let width = 0;
  let topOffset: number | undefined;
  const orientation = document.defaultView?.matchMedia("(orientation: portrait)");
  let portrait = orientation?.matches;
  const update = () => {
    const bounds = host.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) return;
    if (keepTop) {
      const nextPortrait = orientation?.matches;
      const nextWidth = document.documentElement.clientWidth;
      if (screenTop === undefined || portrait !== nextPortrait || width !== nextWidth) {
        screenTop = bounds.top;
        width = nextWidth;
        portrait = nextPortrait;
        host.setCssProps({ "--epub-viewport-screen-top": `${screenTop}px` });
      }
      const offset = screenTop - bounds.top;
      if (offset !== topOffset) {
        topOffset = offset;
        host.setCssProps({ "--epub-viewport-top-offset": `${offset}px` });
      }
    }
    let covered = 0;
    for (const bar of bars) {
      const rect = bar.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || getComputedStyle(bar).visibility === "hidden") continue;
      if (rect.bottom > bounds.top && rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right) {
        covered = Math.max(covered, bounds.bottom - rect.top);
      }
    }
    covered = Math.min(Math.ceil(covered), Math.max(0, Math.floor(bounds.height) - 1));
    if (inset === covered) return;
    inset = covered;
    host.setCssProps({ "--pager-toolbar-overlap": `${inset}px` });
  };
  const resize = new ResizeObserver(update);
  const layoutChanges = new MutationObserver(update);
  if (keepTop) {
    // Obsidian can reposition the leaf without resizing its content.
    for (let element = host.parentElement; element; element = element.parentElement) {
      layoutChanges.observe(element, { attributes: true, attributeFilter: ["class", "style"] });
    }
  }
  const attributes = new MutationObserver(update);
  const refresh = () => {
    const next = Array.from(document.querySelectorAll<HTMLElement>(selector));
    if (next.length !== bars.length || next.some((bar, index) => bar !== bars[index])) {
      for (const bar of bars) resize.unobserve(bar);
      attributes.disconnect();
      bars = next;
      for (const bar of bars) {
        resize.observe(bar);
        attributes.observe(bar, { attributes: true, attributeFilter: ["class", "style", "hidden"] });
      }
    }
    update();
  };
  resize.observe(host);
  refresh();
  lifetime.registerEvent(workspace.on("layout-change", refresh));
  lifetime.registerDomEvent(document, "transitionend", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest(selector)) refresh();
    else if (keepTop && target.contains(host)) update();
  });
  lifetime.register(() => { resize.disconnect(); attributes.disconnect(); layoutChanges.disconnect(); });
}

export function setFocusButton(button: HTMLElement, focused: boolean): void {
  const label = focused ? "退出专注模式" : "进入专注模式";
  setIcon(button, focused ? "minimize-2" : "maximize-2");
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(focused));
  button.title = label;
}

export function bindReaderDrag(lifetime: Component, viewport: HTMLElement, element: HTMLElement, handle: HTMLElement, rail = false): () => void {
  let press: { id: number; x: number; y: number; offsetX: number; offsetY: number } | null = null;
  let timer: number | undefined;
  let suppressClick = false;
  handle.addClass("pager-drag-handle");
  const reset = () => {
    window.clearTimeout(timer);
    press = null;
    element.removeClass("is-dragging");
  };
  const measure = () => {
    if (element.offsetWidth && element.offsetHeight) {
      element.setCssProps({ "--pager-drag-width": `${element.offsetWidth}px`, "--pager-drag-height": `${element.offsetHeight}px` });
    }
  };
  const resize = new ResizeObserver(measure);
  resize.observe(element);
  lifetime.register(() => { reset(); resize.disconnect(); });
  lifetime.registerDomEvent(handle, "pointerdown", (event) => {
    event.stopPropagation();
    if (!event.isPrimary || event.button !== 0) return;
    reset();
    suppressClick = false;
    const { left, top } = element.getBoundingClientRect();
    press = { id: event.pointerId, x: event.clientX, y: event.clientY,
      offsetX: event.clientX - left, offsetY: event.clientY - top };
    const start = () => {
      suppressClick = true;
      handle.setPointerCapture(event.pointerId);
      element.addClass("is-dragging");
    };
    if (rail && event.pointerType !== "mouse") timer = window.setTimeout(start, 500);
    else if (!rail) start();
  });
  lifetime.registerDomEvent(handle, "pointermove", (event) => {
    if (!press || event.pointerId !== press.id) return;
    event.stopPropagation();
    if (!element.hasClass("is-dragging")) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 8) return;
      if (event.pointerType !== "mouse") { reset(); return; }
      suppressClick = true;
      handle.setPointerCapture(event.pointerId);
      element.addClass("is-dragging");
    }
    const { left, top, height } = viewport.getBoundingClientRect();
    const y = event.clientY - top;
    const horizontal = rail && (y < 44 || y > height - 44);
    const changed = horizontal !== element.hasClass("is-horizontal");
    element.toggleClass("is-horizontal", horizontal);
    if (changed) {
      press.offsetX = element.offsetWidth / 2;
      press.offsetY = element.offsetHeight / 2;
    }
    measure();
    element.setCssProps({
      "--pager-drag-left": `${event.clientX - left - press.offsetX}px`,
      "--pager-drag-top": `${y - press.offsetY}px`,
    });
    element.addClass("is-placed");
  });
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    lifetime.registerDomEvent(handle, event, (event) => {
      if (event.type === "lostpointercapture" && event.target !== handle) return;
      if (press?.id === event.pointerId) reset();
    });
  }
  lifetime.registerDomEvent(handle, "pointerleave", () => {
    if (!element.hasClass("is-dragging")) reset();
  });
  lifetime.registerDomEvent(handle, "click", (event) => {
    if (suppressClick && event.detail !== 0) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
  lifetime.registerDomEvent(handle, "contextmenu", (event) => event.preventDefault());
  for (const event of ["touchstart", "touchmove"] as const) {
    lifetime.registerDomEvent(handle, event, (event) => event.stopPropagation(), { passive: true });
  }
  return () => {
    reset();
    element.removeClass("is-placed", "is-horizontal");
  };
}

export function createPanelHeader(panel: HTMLElement, title: string, close: () => void): HTMLElement {
  const row = panel.createDiv("pager-panel-heading");
  const handle = row.createDiv("pager-panel-grip");
  const icon = handle.createSpan({ attr: { "aria-hidden": "true" } });
  setIcon(icon, "grip-horizontal");
  handle.createSpan({ text: title });
  const button = row.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "关闭阅读设置", title: "关闭阅读设置" } });
  setIcon(button, "x");
  button.addEventListener("click", close);
  return handle;
}
