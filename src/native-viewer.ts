import type { FileView } from "obsidian";

export interface PdfEventBus {
  on(name: string, handler: (event: any) => void): void;
  off(name: string, handler: (event: any) => void): void;
}

export interface PdfViewer {
  pdfDocument?: { numPages: number };
  currentPageNumber: number;
  currentScale: number;
  currentScaleValue: string | number;
  scrollMode: number;
  spreadMode: number;
}

export interface NativeViewer {
  pdfViewer: PdfViewer;
  eventBus: PdfEventBus;
}

interface PdfComponent {
  child?: { pdfViewer: NativeViewer };
  then(callback: (child: { pdfViewer: NativeViewer }) => void): void;
}

export function getNativeViewer(view: FileView): Promise<NativeViewer | null> {
  const component = (view as FileView & { viewer?: PdfComponent }).viewer;
  if (!component) return Promise.resolve(null);
  if (component.child?.pdfViewer) return Promise.resolve(component.child.pdfViewer);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (viewer: NativeViewer | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(viewer);
    };
    const timer = window.setTimeout(() => finish(null), 1200);
    component.then((child) => finish(child.pdfViewer ?? null));
  });
}

/** pdf.js ScrollMode.PAGE and SpreadMode.NONE; neither is in Obsidian's public API. */
export const PAGE_MODE = 3;
export const NO_SPREAD = 0;

export function hasExplicitPageTarget(view: FileView): boolean {
  const state = view.leaf.getViewState();
  const data = state.state as Record<string, unknown> | undefined;
  const extra = (state as typeof state & { eState?: Record<string, unknown> }).eState;
  const parts = [data?.subpath, data?.page, extra?.subpath, extra?.page];
  return parts.some((part) => typeof part === "number" || (typeof part === "string" && /(?:^|[#&])page=\d+/.test(part)));
}
