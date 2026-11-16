import type { DataAdapter } from "obsidian";

const FILE = "noto-serif-cjk-sc-2.003.otf";
const SIZE = 24_543_080;
const SHA256 = "2a2eae2628df83556c54018c41e20fa532c1b862c5256ae8b3f23feb918d12ca";

async function readDownloadedSerif(adapter: DataAdapter, folder: string): Promise<Blob | null> {
  try {
    const path = `${folder}/${FILE}`;
    if (!await adapter.exists(path)) return null;
    const data = await adapter.readBinary(path);
    if (data.byteLength !== SIZE || new DataView(data).getUint32(0) !== 0x4f54544f) return null;
    if (window.crypto.subtle) {
      const digest = await window.crypto.subtle.digest("SHA-256", data);
      const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (hash !== SHA256) return null;
    }
    return new Blob([data], { type: "font/otf" });
  } catch {
    return null;
  }
}

let bundledSerif: Blob | undefined;

export async function loadChineseSerif(adapter: DataAdapter, folder: string, host: HTMLElement): Promise<Blob | null> {
  const downloaded = await readDownloadedSerif(adapter, folder);
  if (downloaded) return downloaded;
  if (!bundledSerif) {
    const styles = getComputedStyle(host);
    const count = Number(styles.getPropertyValue("--epub-serif-chunks"));
    if (!Number.isInteger(count) || count < 1) return null;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    for (let chunk = 0; chunk < count; chunk++) {
      const source = styles.getPropertyValue(`--epub-serif-${chunk}`).trim();
      if (!source) return null;
      const decoded = window.atob(source.slice(1, -1));
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
      chunks.push(bytes);
    }
    bundledSerif = new Blob(chunks, { type: "font/woff2" });
  }
  return bundledSerif;
}
