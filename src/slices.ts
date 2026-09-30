export function clampPosition(position: number | undefined): number {
  return typeof position === "number" && Number.isFinite(position)
    ? Math.max(0, Math.min(1, position))
    : 0;
}

/** Each stop shows one viewport of the PDF page; stops share a little content. */
export function sliceCount(pageHeight: number, viewportHeight: number, enabled: boolean): number {
  if (!enabled || !Number.isFinite(pageHeight) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) return 1;
  return Math.max(1, Math.ceil(pageHeight / viewportHeight));
}

export function sliceIndex(position: number, count: number): number {
  return count <= 1 ? 0 : Math.round(clampPosition(position) * (count - 1));
}

export function slicePosition(index: number, count: number): number {
  return count <= 1 ? 0 : Math.max(0, Math.min(count - 1, index)) / (count - 1);
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
