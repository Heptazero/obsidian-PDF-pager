import { requestUrl, type DataAdapter } from "obsidian";

const FILE = "noto-serif-cjk-sc-2.003.otf";
const FONT_URL = "https://raw.githubusercontent.com/notofonts/noto-cjk/Serif2.003/Serif/OTF/SimplifiedChinese/NotoSerifCJKsc-Regular.otf";
const SIZE = 24_543_080;
const SHA256 = "2a2eae2628df83556c54018c41e20fa532c1b862c5256ae8b3f23feb918d12ca";
const downloads = new WeakMap<DataAdapter, Promise<ArrayBuffer>>();

async function isExpectedFont(data: ArrayBuffer): Promise<boolean> {
  if (data.byteLength !== SIZE || new DataView(data).getUint32(0) !== 0x4f54544f) return false;
  if (!window.crypto.subtle) return true;
  const digest = await window.crypto.subtle.digest("SHA-256", data);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hash === SHA256;
}

export async function loadChineseSerif(adapter: DataAdapter, folder: string, download: boolean): Promise<ArrayBuffer | null> {
  const path = `${folder}/${FILE}`;
  if (await adapter.exists(path)) {
    const data = await adapter.readBinary(path);
    if (await isExpectedFont(data)) return data;
  }
  if (!download) return null;
  let pending = downloads.get(adapter);
  if (!pending) {
    pending = (async () => {
      const { arrayBuffer } = await requestUrl({ url: FONT_URL });
      if (!await isExpectedFont(arrayBuffer)) throw new Error("字体文件校验失败");
      await adapter.writeBinary(path, arrayBuffer);
      return arrayBuffer;
    })().finally(() => downloads.delete(adapter));
    downloads.set(adapter, pending);
  }
  return pending;
}
