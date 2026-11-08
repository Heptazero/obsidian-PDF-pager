import { EpubReaderView } from "../../src/epub-view";
import { StateStore } from "../../src/state-store";
import { Platform } from "./obsidian-stub";

const storage = new Map<string, unknown>();
const files = new Map<string, string>();
const folders = new Set<string>();
const listeners = new Map<string, Array<() => void>>();
const app = {
  loadLocalStorage: (key: string) => storage.get(key),
  saveLocalStorage: (key: string, value: unknown) => storage.set(key, value),
  vault: {
    getName: () => "browser-test", configDir: ".obsidian",
    readBinary: async () => (await fetch("/fixture.epub")).arrayBuffer(),
    adapter: {
      exists: async (path: string) => files.has(path) || folders.has(path),
      list: async (path: string) => ({ files: [...files.keys()].filter((file) => file.startsWith(path + "/")) }),
      read: async (path: string) => { if (!files.has(path)) throw Error("missing"); return files.get(path); },
      write: async (path: string, value: string) => { files.set(path, value); },
      mkdir: async (path: string) => { folders.add(path); },
    },
  },
  workspace: {
    getActiveViewOfType: () => active ? view : null,
    on: (name: string, listener: () => void) => {
      listeners.set(name, [...listeners.get(name) ?? [], listener]);
      return { off: () => listeners.set(name, (listeners.get(name) ?? []).filter((fn) => fn !== listener)) };
    },
  },
};
const store = new StateStore(app as never, "records");
const plugin = { app, store, readingIdleMs: 300000, readingDayEndMinutes: 0, refreshReadingLog() {}, syncFocusMode() {}, openReadingLog() {} };
let active = true;
const view = new EpubReaderView({ app } as never, plugin as never);
const file = { path: "fixture.epub", basename: "测试电子书", extension: "epub" };
view.file = file as never;
(window as unknown as Record<string, unknown>).notices = [];
(window as unknown as Record<string, unknown>).harness = {
  view, store, files, storage,
  mobile: () => { Platform.isMobile = true; document.body.classList.add("is-mobile"); },
  layoutChanged: () => { for (const listener of listeners.get("layout-change") ?? []) listener(); },
  open: () => view.onLoadFile(file as never),
  pause: () => { active = false; for (const listener of listeners.get("active-leaf-change") ?? []) listener(); },
  resume: () => { active = true; for (const listener of listeners.get("active-leaf-change") ?? []) listener(); },
};
