const INTERACTIVE = "a, button, input, textarea, select, [role='button'], [contenteditable], .annotationLayer section, .annotationEditorLayer";

export function bindPdfTapPaging(
  container: HTMLElement,
  isEnabled: () => boolean,
  turn: (direction: -1 | 1) => void,
): () => void {
  const document = container.ownerDocument;
  let press: { id: number; x: number; y: number; at: number } | null = null;

  function cancel(): void { press = null; }

  function start(event: TouchEvent): void {
    cancel();
    if (!isEnabled() || event.defaultPrevented || event.touches.length !== 1) return;
    const target = event.target as Element | null;
    if (target?.closest?.(INTERACTIVE) || document.getSelection()?.isCollapsed === false) return;
    const touch = event.touches[0];
    // Keep the system and Obsidian sidebar gesture edges available.
    const width = document.documentElement.clientWidth;
    if (touch.clientX < 22 || touch.clientX > width - 22) return;
    press = { id: touch.identifier, x: touch.clientX, y: touch.clientY, at: event.timeStamp };
  }

  function withinTapDistance(touch: Touch): boolean {
    return !!press && touch.identifier === press.id
      && Math.hypot(touch.clientX - press.x, touch.clientY - press.y) < 10;
  }

  function move(event: TouchEvent): void {
    if (event.touches.length !== 1 || !withinTapDistance(event.touches[0])) cancel();
  }

  function end(event: TouchEvent): void {
    const touch = event.changedTouches[0];
    const isTap = press && touch && withinTapDistance(touch) && event.timeStamp - press.at < 350;
    cancel();
    if (!isTap || event.defaultPrevented || event.touches.length || !isEnabled()
      || document.getSelection()?.isCollapsed === false) return;
    const bounds = container.getBoundingClientRect();
    if (touch.clientX < bounds.left || touch.clientX >= bounds.right
      || touch.clientY < bounds.top || touch.clientY >= bounds.bottom) return;
    turn(touch.clientX < bounds.left + bounds.width / 2 ? -1 : 1);
  }

  container.addEventListener("touchstart", start, { passive: true });
  container.addEventListener("touchmove", move, { passive: true });
  container.addEventListener("touchend", end, { passive: true });
  container.addEventListener("touchcancel", cancel, { passive: true });
  container.addEventListener("contextmenu", cancel);
  return () => {
    cancel();
    container.removeEventListener("touchstart", start);
    container.removeEventListener("touchmove", move);
    container.removeEventListener("touchend", end);
    container.removeEventListener("touchcancel", cancel);
    container.removeEventListener("contextmenu", cancel);
  };
}
