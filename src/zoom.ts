/** Keep a deliberate pinch enlargement when the width floor changes. */
export function scaleForNewFloor(current: number, oldFloor: number, newFloor: number): number {
  if (!(Number.isFinite(current) && current > 0)) return newFloor;
  if (!(Number.isFinite(oldFloor) && oldFloor > 0)) return Math.max(current, newFloor);
  if (current <= oldFloor * 1.01) return newFloor;
  return Math.max(current, newFloor);
}

export function relativeZoom(current: number, floor: number): number {
  return Number.isFinite(current) && Number.isFinite(floor) && floor > 0
    ? Math.max(1, current / floor)
    : 1;
}

export function centeredScrollLeft(scrollLeft: number, viewportWidth: number, pageCenterDelta: number, scrollWidth: number): number {
  return Math.max(0, Math.min(scrollWidth - viewportWidth, scrollLeft + pageCenterDelta));
}
