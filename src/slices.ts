export function clampPosition(position: number | undefined): number {
  return typeof position === "number" && Number.isFinite(position)
    ? Math.max(0, Math.min(1, position))
    : 0;
}

/** Each stop shows one viewport of the PDF page; the final stop may share content. */
export function sliceCount(pageHeight: number, viewportHeight: number, enabled: boolean): number {
  if (!enabled || !Number.isFinite(pageHeight) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) return 1;
  return Math.max(1, Math.ceil(pageHeight / viewportHeight));
}

/** Pixel distance from the top of a page to a paging stop. */
export function sliceOffset(index: number, pageHeight: number, viewportHeight: number, count: number): number {
  if (count <= 1 || !Number.isFinite(pageHeight) || !Number.isFinite(viewportHeight)) return 0;
  const travel = Math.max(0, pageHeight - viewportHeight);
  return Math.max(0, Math.min(travel, Math.max(0, Math.trunc(index)) * viewportHeight));
}

/** Nearest paging stop for a pixel offset within the page. */
export function sliceIndexAtOffset(offset: number, pageHeight: number, viewportHeight: number, count: number): number {
  if (count <= 1 || !Number.isFinite(offset)) return 0;
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < count; index += 1) {
    const difference = Math.abs(sliceOffset(index, pageHeight, viewportHeight, count) - offset);
    if (difference < distance) { nearest = index; distance = difference; }
  }
  return nearest;
}

/** Normalized position used by the persisted reading state. */
export function slicePosition(index: number, pageHeight: number, viewportHeight: number, count: number): number {
  const travel = Math.max(0, pageHeight - viewportHeight);
  return travel > 0 ? sliceOffset(index, pageHeight, viewportHeight, count) / travel : 0;
}

export function scrollTopForPosition(
  pageTop: number, pageHeight: number, viewportHeight: number,
  position: number, scrollMax: number,
): number {
  const pageTravel = Math.max(0, pageHeight - viewportHeight);
  return Math.max(0, Math.min(scrollMax, pageTop + clampPosition(position) * pageTravel));
}

export function positionFromScroll(scrollTop: number, pageTop: number, pageHeight: number, viewportHeight: number): number {
  const pageTravel = Math.max(0, pageHeight - viewportHeight);
  return pageTravel > 0 ? clampPosition((scrollTop - pageTop) / pageTravel) : 0;
}
